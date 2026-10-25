"""A WorkRB model that embeds through the Workers AI REST API (Cofferdam, 2026-10-25).

Cofferdam's plane embeds with Workers AI, so the encoders compared here are the
ones Workers AI hosts: @cf/baai/bge-m3 (in production), @cf/google/embeddinggemma-300m
and @cf/qwen/qwen3-embedding-0.6b. Each is called the way its model card
recommends:

- bge-m3: plain text, as `cofferdam-api` sends it ({"text": [...]}, 100 a call).
- EmbeddingGemma: the card's retrieval prompts, "task: search result | query: "
  before a query and "title: none | text: " before a document (100 a call).
- Qwen3-Embedding: queries with a task instruction, documents without one
  ({"queries", "instruction"} or {"documents"}, 32 a call).

Embeddings are cached in SQLite (float16) per model, so a text is embedded once
however many tasks use it. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
in the environment (direnv); the token is never printed or stored.
"""

from __future__ import annotations

import concurrent.futures as cf
import hashlib
import os
import sqlite3
import time

import numpy as np
import requests
import torch

from workrb.models.base import ModelInterface
from workrb.types import ModelInputType

GEMMA_QUERY = "task: search result | query: "
GEMMA_DOCUMENT = "title: none | text: "

# Qwen3 instructions per (query type, target type); the target side gets none.
QWEN_INSTRUCTIONS = {
    (ModelInputType.JOB_TITLE, ModelInputType.SKILL_NAME): "Given an occupation title, retrieve the skills the occupation requires",
    (ModelInputType.JOB_TITLE, ModelInputType.JOB_TITLE): "Given a job title, retrieve the standard occupation it corresponds to",
    (ModelInputType.SKILL_SENTENCE, ModelInputType.SKILL_NAME): "Given a sentence from a job posting or a CV, retrieve the skills it mentions",
    (ModelInputType.SKILL_NAME, ModelInputType.JOB_TITLE): "Given a skill, retrieve the occupations that require it",
    (ModelInputType.SKILL_NAME, ModelInputType.SKILL_NAME): "Given a skill, retrieve the standard skill it corresponds to",
}
QWEN_DEFAULT = "Given a query, retrieve relevant passages that answer the query"


class WorkersAIEmbedModel(ModelInterface):
    """Cosine ranking over Workers AI embeddings, cached on disk."""

    def __init__(self, model: str, cache_dir: str, workers: int = 6):
        self.model = model
        self.short = model.split("/")[-1]
        self.batch = 32 if "qwen3" in model else 100
        self.workers = workers
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/ai/run/{model}"
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}"
        os.makedirs(cache_dir, exist_ok=True)
        self.db = sqlite3.connect(os.path.join(cache_dir, f"{self.short}.sqlite"))
        self.db.execute("CREATE TABLE IF NOT EXISTS emb (key TEXT PRIMARY KEY, vec BLOB)")
        self.calls = 0

    @property
    def name(self) -> str:
        return f"WorkersAI-{self.short}"

    @property
    def description(self) -> str:
        return f"{self.model} through the Workers AI REST API, cosine similarity"

    # ── embedding ────────────────────────────────────────────────────────────

    def _payload(self, texts: list[str], role: str, instruction: str | None) -> dict:
        if "qwen3" in self.model:
            if role == "query":
                return {"queries": texts, "instruction": instruction or QWEN_DEFAULT}
            return {"documents": texts}
        if "embeddinggemma" in self.model:
            prefix = GEMMA_QUERY if role == "query" else GEMMA_DOCUMENT
            return {"text": [prefix + t for t in texts]}
        return {"text": texts}

    def _post(self, texts: list[str], role: str, instruction: str | None) -> list[list[float]]:
        body = self._payload(texts, role, instruction)
        for attempt in range(8):
            try:
                r = self.session.post(self.url, json=body, timeout=120)
                if r.status_code == 200:
                    result = r.json().get("result") or {}
                    vectors = result.get("data") or result.get("response")
                    if isinstance(vectors, list) and len(vectors) == len(texts):
                        self.calls += 1
                        return vectors
                    raise RuntimeError(f"{self.short}: {len(vectors or [])} vectors for {len(texts)} texts")
                if r.status_code not in (408, 429, 500, 502, 503, 504):
                    raise RuntimeError(f"{self.short}: HTTP {r.status_code}: {r.text[:300]}")
            except (requests.ConnectionError, requests.Timeout):
                pass
            time.sleep(min(60, 2 ** attempt))
        raise RuntimeError(f"{self.short}: gave up after 8 attempts")

    def _key(self, text: str, role: str, instruction: str | None) -> str:
        return hashlib.sha1(f"{self.model}\x00{role}\x00{instruction or ''}\x00{text}".encode()).hexdigest()

    def _embed(self, texts: list[str], role: str, instruction: str | None = None) -> np.ndarray:
        unique = list(dict.fromkeys(texts))
        keys = {t: self._key(t, role, instruction) for t in unique}
        have: dict[str, np.ndarray] = {}
        rows = list(keys.items())
        for i in range(0, len(rows), 900):
            part = rows[i : i + 900]
            q = f"SELECT key, vec FROM emb WHERE key IN ({','.join('?' * len(part))})"
            found = dict(self.db.execute(q, [k for _, k in part]).fetchall())
            for t, k in part:
                if k in found:
                    have[t] = np.frombuffer(found[k], dtype=np.float16).astype(np.float32)
        missing = [t for t in unique if t not in have]
        batches = [missing[i : i + self.batch] for i in range(0, len(missing), self.batch)]
        if batches:
            print(f"  {self.short}: embedding {len(missing)} of {len(unique)} texts as {role}s in {len(batches)} calls", flush=True)
        done = 0
        with cf.ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = {pool.submit(self._post, b, role, instruction): b for b in batches}
            for f in cf.as_completed(futures):
                b = futures[f]
                vecs = f.result()
                with self.db:
                    self.db.executemany(
                        "INSERT OR REPLACE INTO emb (key, vec) VALUES (?, ?)",
                        [(keys[t], np.asarray(v, dtype=np.float16).tobytes()) for t, v in zip(b, vecs)],
                    )
                for t, v in zip(b, vecs):
                    have[t] = np.asarray(v, dtype=np.float32)
                done += 1
                if done % 100 == 0:
                    print(f"    {done}/{len(batches)} calls", flush=True)
        return np.stack([have[t] for t in texts])

    # ── WorkRB interface ─────────────────────────────────────────────────────

    def _compute_rankings(self, queries, targets, query_input_type=None, target_input_type=None) -> torch.Tensor:
        instruction = QWEN_INSTRUCTIONS.get((query_input_type, target_input_type), QWEN_DEFAULT)
        q = torch.from_numpy(self._embed(queries, "query", instruction))
        d = torch.from_numpy(self._embed(targets, "document"))
        q = torch.nn.functional.normalize(q, p=2, dim=1)
        d = torch.nn.functional.normalize(d, p=2, dim=1)
        return q @ d.T

    def _compute_classification(self, texts, targets, input_type, target_input_type=None) -> torch.Tensor:
        return self._compute_rankings(texts, targets, input_type, target_input_type or input_type)

    @property
    def classification_label_space(self):
        return None
