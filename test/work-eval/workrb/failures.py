"""Nearest ESCO occupations for the strings that went wrong in Cofferdam's live tests, bge-m3 against EmbeddingGemma.

Every ESCO v1.2.1 occupation label (preferred and alternative) in the query's
language is a document; each string is a query; an occupation scores the best
of its labels. Prints the top three occupations by their English name.
"""

import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

from workers_ai_model import WorkersAIEmbedModel  # noqa: E402
from workrb.types import ModelInputType as T  # noqa: E402

ESCO = "/Users/hoff/Development/esco/ESCO dataset - v1.2.1 - classification - {lang} - csv/occupations_{lang}.csv"
QUERIES = {
    "pt": ["Encanador", "Eletricista", "Terceiro Oficial de Máquinas", "Oficial de Máquinas", "Pedreiro", "Tradutora", "Soldador de Tubulação"],
    "es": ["Plomero", "Electricista", "Tercer Ingeniero", "Traductora", "Albañil", "Soldador"],
    "en": ["Third Engineer", "Service Plumber", "Journeyman Electrician", "Motorman", "Able Seaman"],
}


def occupations(lang):
    with open(ESCO.format(lang=lang), encoding="utf-8") as f:
        for row in csv.DictReader(f):
            labels = [row["preferredLabel"], *[a for a in row.get("altLabels", "").split("\n") if a.strip()]]
            yield row["conceptUri"], [l.strip() for l in labels if l.strip()]


english = {uri: labels[0] for uri, labels in occupations("en")}
models = {
    "bge-m3": WorkersAIEmbedModel("@cf/baai/bge-m3", cache_dir="/Users/hoff/Development/workrb-bench/cache"),
    "EmbeddingGemma": WorkersAIEmbedModel("@cf/google/embeddinggemma-300m", cache_dir="/Users/hoff/Development/workrb-bench/cache"),
}
for lang, queries in QUERIES.items():
    pairs = [(uri, label) for uri, labels in occupations(lang) for label in labels]
    texts = [label for _, label in pairs]
    for name, model in models.items():
        d = model._embed(texts, "document")
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        q = model._embed(queries, "query", "Given a job title, retrieve the standard occupation it corresponds to")
        q /= np.linalg.norm(q, axis=1, keepdims=True)
        sims = q @ d.T
        for qi, query in enumerate(queries):
            best: dict[str, float] = {}
            for j in np.argsort(-sims[qi])[:200]:
                uri = pairs[j][0]
                best[uri] = max(best.get(uri, -1.0), float(sims[qi, j]))
            top = sorted(best.items(), key=lambda kv: -kv[1])[:3]
            print(f"{lang} | {query} | {name} | " + "; ".join(f"{english.get(u, u)} {s:.2f}" for u, s in top), flush=True)
