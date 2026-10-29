# Copyright (c) 2026 Cofferdam Inc.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = ["laya==0.4.17"]
# ///
"""Answer the Clef requests an evaluation left pending, with Convai's Laya in process.

Laya (convaiinnovations/laya, Apache-2.0) is a non-autoregressive System 1
decision model: it answers Clef's `noul`, `choice` and `score` questions over
a state with calibrated probabilities, in Clef's own answer shape. The Clef
evaluations (test/workClef.eval.test.ts with WORK_CLEF_LOCAL, test/chat.eval.test.ts
with CHAT_CLEF_LOCAL) take {"label": "...", "answers": "<file>"}: a run writes
the requests it could not answer to <file>.pending.jsonl and fails them; this
script answers them with Laya's router (its English checkpoint for English
states, the multilingual one for the rest) and writes the answers into <file>
by request key; the next run reads them. Workspace decision 0068.

  uv run scripts/work/laya-answers.py <answers.json>

Nothing leaves the Mac but the model's download from Hugging Face.
"""

import json
import pathlib
import sys
import time


def main(path: str) -> None:
    from laya import Router

    answers_path = pathlib.Path(path).expanduser()
    pending_path = answers_path.with_name(answers_path.name + ".pending.jsonl")
    answers = json.loads(answers_path.read_text()) if answers_path.exists() else {}
    pending = [json.loads(line) for line in pending_path.read_text().splitlines() if line.strip()] if pending_path.exists() else []
    todo = [p for p in pending if p["key"] not in answers]
    router = Router()
    started = time.time()
    for i, p in enumerate(todo, 1):
        out = router.predict(p["state"], p["questions"])
        answers[p["key"]] = {"answers": out.get("answers", {}), "routing": out.get("routing")}
        if i % 25 == 0:
            print(f"{i}/{len(todo)} answered", flush=True)
    answers_path.write_text(json.dumps(answers))
    pending_path.write_text("")
    took = time.time() - started
    print(f"{len(todo)} answered in {took:.1f} s ({1000 * took / max(1, len(todo)):.0f} ms each); {len(answers)} in {answers_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: laya-answers.py <answers.json>")
    main(sys.argv[1])
