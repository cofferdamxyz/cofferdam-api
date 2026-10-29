# Copyright (c) 2026 Cofferdam Inc.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = ["litert-lm==0.18.1"]
# ///
"""Answer the parse requests a benchmark run left pending, with LiteRT-LM in process.

A local reader with `answers` in place of `url` (test/work-eval/localAi.ts) lists each
request it has no answer for in `<answers>.pending.jsonl`: the OpenAI-shaped body a server
would have received, keyed by its SHA-256. This script reads them with Google's LiteRT-LM
(the runtime of workspace decision 0068's local track), writes each answer and its timing
into `<answers>` by key, and leaves in the pending file only what it could not answer; the
next run of the benchmark scores the answers. `litert-lm serve` drops what this test needs
(LiteRT-LM's repetition guards, the answer's cap, a seed), which is why it runs in process.

From the body: the system and user messages (text only: the text path), `max_tokens` (the
answer's cap), `temperature` (0 is greedy: top-k 1), `response_format` (a JSON schema,
decoded under llguidance) and thinking off (`chat_template_kwargs.enable_thinking`), and
the reader's `sampling` keys, which map to LiteRT-LM's own settings:
`no_repeat_ngram_size` and `no_repeat_window`; `repetition_penalty`, `presence_penalty`,
`frequency_penalty` and `repetition_window`; `top_k`, `top_p`, `seed`. From the command
line: the model file, the backend and multi-token prediction (MTP).

  uv run scripts/work/litert-answers.py <answers.json> --model <file.litertlm>
      [--backend gpu|cpu] [--mtp on|off|model] [--max-num-tokens 16384]

Each answer carries `timing`: the milliseconds the call took, the first token, prefill and
decode speeds and the process's peak memory footprint during it (macOS `phys_footprint`).
`<answers>.runtime.json` keeps the run's settings, the footprint once the model is loaded
and the peak. Nothing leaves the Mac; it prints counts and timings, never a request's text.
"""

import argparse
import ctypes
import ctypes.util
import json
import os
import pathlib
import statistics
import sys
import threading
import time

import litert_lm


class _RusageInfoV0(ctypes.Structure):
  # `struct rusage_info_v0` of <sys/resource.h>: phys_footprint is what iOS and macOS charge a process.
  _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [
      (name, ctypes.c_uint64)
      for name in (
          "ri_user_time", "ri_system_time", "ri_pkg_idle_wkups", "ri_interrupt_wkups",
          "ri_pageins", "ri_wired_size", "ri_resident_size", "ri_phys_footprint",
          "ri_proc_start_abstime", "ri_proc_exit_abstime",
      )
  ]


_libproc = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib")


def footprint_mb() -> float:
  info = _RusageInfoV0()
  if _libproc.proc_pid_rusage(os.getpid(), 0, ctypes.byref(info)) != 0:
    return float("nan")
  return info.ri_phys_footprint / 2**20


class PeakSampler:
  """Samples this process's footprint every 100 ms; `peak` is the highest since the last `reset`."""

  def __init__(self):
    self.peak = footprint_mb()
    self.overall = self.peak
    self._stop = threading.Event()
    self._thread = threading.Thread(target=self._run, daemon=True)
    self._thread.start()

  def _run(self):
    while not self._stop.wait(0.1):
      now = footprint_mb()
      self.peak = max(self.peak, now)
      self.overall = max(self.overall, now)

  def reset(self):
    self.peak = footprint_mb()

  def stop(self):
    self._stop.set()
    self._thread.join()


def text_of(content) -> str:
  if isinstance(content, str):
    return content
  if isinstance(content, list):
    parts = []
    for part in content:
      if isinstance(part, dict) and part.get("type") == "text":
        parts.append(str(part.get("text", "")))
      elif isinstance(part, dict):
        raise ValueError(f"unsupported content part: {part.get('type')}")
    return "".join(parts)
  raise ValueError("unsupported message content")


def reply_text(message) -> str:
  # A reply's `contents` is a list of parts whose `str` joins its text parts (litert_lm._messages.Contents).
  contents = getattr(message, "contents", None)
  if contents is not None:
    return str(contents)
  content = message.get("content") if isinstance(message, dict) else None
  return text_of(content) if content is not None else str(message)


def schema_of(response_format):
  if not isinstance(response_format, dict) or response_format.get("type") != "json_schema":
    return None
  inner = response_format.get("json_schema")
  if isinstance(inner, dict) and "schema" in inner and isinstance(inner.get("schema"), dict):
    return inner["schema"]
  return inner


def answer_one(engine, body: dict, mtp, sampler: PeakSampler) -> dict:
  messages = body.get("messages") or []
  system = next((text_of(m.get("content")) for m in messages if m.get("role") == "system"), None)
  user = next((text_of(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), None)
  if user is None:
    raise ValueError("no user message")
  temperature = float(body.get("temperature", 0) or 0)
  if temperature == 0:
    sampler_config = litert_lm.SamplerConfig(top_k=1, top_p=1.0, temperature=1.0, seed=int(body.get("seed", 0)))
  else:
    sampler_config = litert_lm.SamplerConfig(
        top_k=int(body.get("top_k", 40)), top_p=float(body.get("top_p", 0.95)),
        temperature=temperature, seed=int(body.get("seed", 0)))
  thinking = (body.get("chat_template_kwargs") or {}).get("enable_thinking")
  thinking_config = litert_lm.ThinkingConfig(enable_thinking=bool(thinking)) if thinking is not None else None
  schema = schema_of(body.get("response_format"))
  constrained = (
      litert_lm.ConstrainedDecodingConfig(enable=True, provider=litert_lm.LiteRtLmConstraintProviderType.LL_GUIDANCE)
      if schema is not None else None
  )
  penalties = {k: body[k] for k in ("repetition_penalty", "presence_penalty", "frequency_penalty") if k in body}
  repetition = (
      litert_lm.RepetitionPenaltyConfig(**{k: float(v) for k, v in penalties.items()},
                                        window_size=int(body.get("repetition_window", 0)))
      if penalties else None
  )
  ngram = (
      litert_lm.NoRepeatNgramConfig(no_repeat_ngram_size=int(body["no_repeat_ngram_size"]),
                                    window_size=int(body.get("no_repeat_window", 0)))
      if "no_repeat_ngram_size" in body else None
  )
  max_tokens = int(body["max_tokens"]) if body.get("max_tokens") else None

  conversation = engine.create_conversation(
      system_message=system, sampler_config=sampler_config, thinking_config=thinking_config,
      constrained_decoding_config=constrained, enable_speculative_decoding=mtp)
  try:
    sampler.reset()
    started = time.perf_counter()
    reply = conversation.send_message(
        user, repetition_penalty_config=repetition, no_repeat_ngram_config=ngram,
        max_output_tokens=max_tokens,
        response_format=litert_lm.ResponseFormat.json(schema) if schema is not None else None)
    ms = (time.perf_counter() - started) * 1000
    bench = conversation.get_benchmark_info()
  finally:
    conversation.close()
  decode_tokens = int(bench.last_decode_token_count)
  return {
      "choices": [{
          "index": 0,
          "message": {"role": "assistant", "content": reply_text(reply)},
          "finish_reason": "length" if max_tokens and decode_tokens >= max_tokens else "stop",
      }],
      "usage": {"prompt_tokens": int(bench.last_prefill_token_count), "completion_tokens": decode_tokens},
      "timing": {
          "ms": round(ms),
          "ttftMs": round(bench.time_to_first_token_in_second * 1000),
          "prefillTps": round(bench.last_prefill_tokens_per_second, 1),
          "decodeTps": round(bench.last_decode_tokens_per_second, 1),
          "peakFootprintMb": round(sampler.peak),
      },
  }


def save(path: pathlib.Path, data) -> None:
  tmp = path.with_name(path.name + ".tmp")
  tmp.write_text(json.dumps(data, indent=1) + "\n")
  tmp.replace(path)


def main() -> int:
  parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
  parser.add_argument("answers", type=pathlib.Path)
  parser.add_argument("--model", required=True, type=pathlib.Path)
  parser.add_argument("--backend", choices=("gpu", "cpu"), default="gpu")
  parser.add_argument("--mtp", choices=("on", "off", "model"), default="on")
  parser.add_argument("--max-num-tokens", type=int, default=16384)
  args = parser.parse_args()

  pending_path = args.answers.with_name(args.answers.name + ".pending.jsonl")
  pending: dict[str, dict] = {}
  if pending_path.exists():
    for line in pending_path.read_text().splitlines():
      if line.strip():
        item = json.loads(line)
        pending[item["key"]] = item["body"]
  known: dict = json.loads(args.answers.read_text()) if args.answers.exists() else {}
  todo = [(k, b) for k, b in pending.items() if k not in known]
  if not todo:
    print(f"nothing pending ({len(known)} answers known)")
    return 0

  sampler = PeakSampler()
  before = footprint_mb()
  backend = litert_lm.Backend.GPU() if args.backend == "gpu" else litert_lm.Backend.CPU()
  cache_dir = args.answers.parent / "litert-cache"
  cache_dir.mkdir(parents=True, exist_ok=True)
  loading = time.perf_counter()
  engine = litert_lm.Engine(str(args.model), backend=backend, max_num_tokens=args.max_num_tokens,
                            cache_dir=str(cache_dir), enable_benchmark=True)
  load_s = time.perf_counter() - loading
  loaded = footprint_mb()
  mtp = {"on": True, "off": False, "model": None}[args.mtp]
  print(f"loaded {args.model.name} on {args.backend} in {load_s:.1f} s; footprint {before:.0f} -> {loaded:.0f} MB; "
        f"{len(todo)} pending, {len(known)} known")

  timings, failed = [], 0
  try:
    for i, (key, body) in enumerate(todo, 1):
      try:
        answer = answer_one(engine, body, mtp, sampler)
        t = answer["timing"]
        timings.append(t)
        print(f"{i}/{len(todo)}: {t['ms'] / 1000:.1f} s, {answer['usage']['completion_tokens']} tokens, "
              f"{t['decodeTps']} tok/s, first token {t['ttftMs']} ms, peak {t['peakFootprintMb']} MB", flush=True)
      except Exception as err:  # noqa: BLE001 - every failure is recorded, then the next request runs
        failed += 1
        answer = {"error": f"{type(err).__name__}: {str(err)[:180]}"}
        print(f"{i}/{len(todo)}: FAIL {answer['error']}", flush=True)
      known[key] = answer
      save(args.answers, known)
  finally:
    engine.close()
    sampler.stop()

  left = {k: b for k, b in pending.items() if k not in known}
  pending_path.write_text("".join(json.dumps({"key": k, "body": b}) + "\n" for k, b in left.items()))
  runtime = {
      "litertLm": "0.18.1", "model": args.model.name, "backend": args.backend, "mtp": args.mtp,
      "maxNumTokens": args.max_num_tokens, "loadSeconds": round(load_s, 1),
      "loadedFootprintMb": round(loaded), "peakFootprintMb": round(sampler.overall),
  }
  save(args.answers.with_name(args.answers.stem + ".runtime.json"), runtime)
  if timings:
    ms = [t["ms"] for t in timings]
    print(f"answered {len(timings)}, failed {failed}; median {statistics.median(ms) / 1000:.1f} s, "
          f"median decode {statistics.median(t['decodeTps'] for t in timings):.1f} tok/s; "
          f"peak footprint {sampler.overall:.0f} MB (loaded {loaded:.0f} MB)")
  else:
    print(f"answered 0, failed {failed}")
  return 0


if __name__ == "__main__":
  sys.exit(main())
