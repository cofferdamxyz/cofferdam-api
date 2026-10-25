"""Two stages on Workers AI (Cofferdam, 2026-10-25): an embedding shortlist, then a reranker.

The base model (WorkersAIEmbedModel) ranks every target; the reranker
(@cf/baai/bge-reranker-base, one call per query with its top_k candidates) rescores
the shortlist, which is placed above all other targets in its new order. Reranker
scores are cached in SQLite, so a re-run costs nothing.
"""

from __future__ import annotations

import concurrent.futures as cf
import hashlib
import os
import sqlite3
import time

import requests
import torch

from workrb.models.base import ModelInterface


class RerankModel(ModelInterface):
    def __init__(self, base, cache_dir: str, reranker: str = "@cf/baai/bge-reranker-base", top_k: int = 30, workers: int = 6):
        self.base = base
        self.reranker = reranker
        self.top_k = top_k
        self.workers = workers
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/ai/run/{reranker}"
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}"
        os.makedirs(cache_dir, exist_ok=True)
        self.db = sqlite3.connect(os.path.join(cache_dir, f"{reranker.split('/')[-1]}.sqlite"))
        self.db.execute("CREATE TABLE IF NOT EXISTS score (key TEXT PRIMARY KEY, value REAL)")
        self.calls = 0

    @property
    def name(self) -> str:
        return f"{self.base.name}+{self.reranker.split('/')[-1]}@{self.top_k}"

    @property
    def description(self) -> str:
        return f"{self.base.description}, top {self.top_k} rescored by {self.reranker}"

    def _key(self, query: str, target: str) -> str:
        return hashlib.sha1(f"{query}\x00{target}".encode()).hexdigest()

    def _cached(self, query: str, candidates: list[str]) -> list[float] | None:
        """Main thread only: SQLite connections cannot cross threads."""
        keys = [self._key(query, c) for c in candidates]
        found = dict(self.db.execute(f"SELECT key, value FROM score WHERE key IN ({','.join('?' * len(keys))})", keys).fetchall())
        return [found[k] for k in keys] if len(found) == len(keys) else None

    def _rerank(self, query: str, candidates: list[str]) -> list[float]:
        """Worker threads: the HTTP call only."""
        body = {"query": query, "contexts": [{"text": c} for c in candidates], "top_k": len(candidates)}
        for attempt in range(8):
            try:
                r = self.session.post(self.url, json=body, timeout=120)
                if r.status_code == 200:
                    out = (r.json().get("result") or {}).get("response") or []
                    scores = [None] * len(candidates)
                    for item in out:
                        scores[item["id"]] = float(item["score"])
                    if any(s is None for s in scores):
                        raise RuntimeError(f"reranker answered {len(out)} scores for {len(candidates)} candidates")
                    self.calls += 1
                    return scores
                if r.status_code not in (408, 429, 500, 502, 503, 504):
                    raise RuntimeError(f"reranker HTTP {r.status_code}: {r.text[:300]}")
            except (requests.ConnectionError, requests.Timeout):
                pass
            time.sleep(min(60, 2 ** attempt))
        raise RuntimeError("reranker gave up after 8 attempts")

    def _compute_rankings(self, queries, targets, query_input_type=None, target_input_type=None) -> torch.Tensor:
        sims = self.base._compute_rankings(queries, targets, query_input_type, target_input_type)
        k = min(self.top_k, sims.shape[1])
        top = sims.topk(k, dim=1).indices
        jobs = {i: [targets[j] for j in top[i].tolist()] for i in range(len(queries))}
        print(f"  reranking the top {k} of {len(targets)} for {len(queries)} queries", flush=True)
        results: dict[int, list[float]] = {}
        for i, c in jobs.items():
            cached = self._cached(queries[i], c)
            if cached is not None:
                results[i] = cached
        todo = {i: c for i, c in jobs.items() if i not in results}
        if len(todo) < len(jobs):
            print(f"  {len(jobs) - len(todo)} queries already scored", flush=True)
        done = 0
        with cf.ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = {pool.submit(self._rerank, queries[i], c): i for i, c in todo.items()}
            for f in cf.as_completed(futures):
                i = futures[f]
                results[i] = f.result()
                with self.db:
                    self.db.executemany(
                        "INSERT OR REPLACE INTO score (key, value) VALUES (?, ?)",
                        [(self._key(queries[i], c), s) for c, s in zip(jobs[i], results[i])],
                    )
                done += 1
                if done % 1000 == 0:
                    print(f"    {done}/{len(jobs)} queries", flush=True)
        out = sims.clone()
        for i, scores in results.items():
            out[i, top[i]] = 10.0 + torch.tensor(scores, dtype=out.dtype)
        return out

    def _compute_classification(self, texts, targets, input_type, target_input_type=None) -> torch.Tensor:
        return self._compute_rankings(texts, targets, input_type, target_input_type or input_type)

    @property
    def classification_label_space(self):
        return None
