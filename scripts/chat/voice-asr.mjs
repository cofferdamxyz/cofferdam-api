// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The chat bar by voice, measured on the Mac (workspace decision 0068,
 * proposed amendment of 2026-10-28). Every prompt of
 * `test/chat-eval/prompts.json` is spoken by a macOS voice of its language
 * (`say`, then 16 kHz mono WAV through `afconvert`), transcribed by a local
 * speech model behind an OpenAI-compatible server (LFM3-Omni-2B on
 * llama.cpp's `llama-server`: an `input_audio` part and the system prompt
 * "Perform ASR in <language>."), and scored by word error rate against what
 * was said. A handle is said as a name ("@ana" as "ana"), as a person would
 * say it.
 *
 * The report goes to `test/chat-eval/voice-<date>-<label>.md`. The prompts,
 * each text replaced by its transcript, go to the OS temp folder for
 * `CHAT_EVAL_PROMPTS=<file>` in `test/chat.eval.test.ts`, which routes them
 * through the real turn. Synthetic speech only: no person's voice is
 * recorded, and nothing leaves the Mac.
 *
 *   node scripts/chat/voice-asr.mjs --url http://127.0.0.1:8084 --label "LFM3-Omni-2B Q4_0 (llama.cpp, Mac)"
 *
 * Options: --only <regex> (prompt ids), --out <dir> (test/chat-eval), --timeout <ms> (120000).
 * Needs macOS (`say`, `afconvert`, `afinfo`) with the voices Luciana, Paulina, Samantha and Eddy.
 */

/* global fetch, AbortSignal -- Node 24's own */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://127.0.0.1:8084').replace(/\/+$/, '');
const label = arg('label', 'local speech model');
const only = arg('only') ? new RegExp(arg('only')) : null;
const outDir = arg('out', join(root, 'test', 'chat-eval'));
const timeoutMs = Number(arg('timeout', '120000'));

/** Two voices a language, alternating: a woman's (the system's classic voice) and a man's. */
const VOICES = {
  pt: ['Luciana', 'Eddy (Portuguese (Brazil))'],
  es: ['Paulina', 'Eddy (Spanish (Mexico))'],
  en: ['Samantha', 'Eddy (English (US))'],
};
const LANGUAGE = { pt: 'Portuguese', es: 'Spanish', en: 'English' };

/** Words for the error rate: no case, accents or punctuation, so "João!" and "joao" are one word. */
const words = (s) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Word-level edit distance over the reference's length. */
function wer(said, heard) {
  const r = words(said);
  const h = words(heard);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/** What a person says for a typed prompt: a handle's name without the @. */
const spoken = (text) => text.replace(/@([\p{L}\p{N}_.]+)/gu, '$1');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout;
}

function speak(text, voice, dir, id) {
  const aiff = join(dir, `${id}.aiff`);
  const wav = join(dir, `${id}.wav`);
  run('say', ['-v', voice, '-o', aiff, text]);
  run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  const seconds = Number(/estimated duration: ([\d.]+)/.exec(run('afinfo', [wav]))?.[1] ?? NaN);
  return { wav, seconds };
}

async function transcribe(wav, lang) {
  const body = {
    model: 'asr',
    stream: false,
    temperature: 0,
    max_tokens: 200,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: `Perform ASR in ${LANGUAGE[lang]}.` },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: readFileSync(wav).toString('base64'), format: 'wav' } }] },
    ],
  };
  const t0 = Date.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  return { heard: String(json.choices?.[0]?.message?.content ?? '').trim(), ms: Date.now() - t0 };
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

async function main() {
  const prompts = JSON.parse(readFileSync(join(root, 'test', 'chat-eval', 'prompts.json'), 'utf8')).filter((p) => !only || only.test(p.id));
  const dir = mkdtempSync(join(tmpdir(), 'cofferdam-voice-'));
  const seen = { pt: 0, es: 0, en: 0 };
  const rows = [];
  try {
    for (const p of prompts) {
      const voices = VOICES[p.language];
      if (!voices) throw new Error(`${p.id}: no voice for language ${p.language}`);
      const voice = voices[seen[p.language]++ % voices.length];
      const said = spoken(p.text);
      const { wav, seconds } = speak(said, voice, dir, p.id);
      let heard = '';
      let ms = NaN;
      let error = null;
      try {
        ({ heard, ms } = await transcribe(wav, p.language));
      } catch (err) {
        error = String(err?.message ?? err).slice(0, 200);
      }
      const row = { id: p.id, language: p.language, voice, said, heard, seconds, ms, wer: error ? 1 : wer(said, heard), error };
      rows.push(row);
      console.log(`${row.wer === 0 ? 'ok  ' : row.error ? 'ERR ' : 'diff'} ${p.id} (${Math.round(ms)} ms): ${error ?? heard}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const summary = (lang) => {
    const rs = lang ? rows.filter((r) => r.language === lang) : rows;
    const totalWords = rs.reduce((n, r) => n + words(r.said).length, 0);
    const errors = rs.reduce((n, r) => n + r.wer * words(r.said).length, 0);
    const secs = median(rs.map((r) => r.seconds));
    const ms = median(rs.map((r) => r.ms));
    return `| ${lang ?? 'All'} | ${rs.length} | ${pct(totalWords ? errors / totalWords : 0)} | ${pct(rs.filter((r) => r.wer === 0).length / Math.max(rs.length, 1))} | ${secs.toFixed(1)} | ${Math.round(ms)} | ${(ms / 1000 / secs).toFixed(2)} | ${rs.filter((r) => r.error).length} |`;
  };
  const byVoice = (lang, voice) => {
    const rs = rows.filter((r) => r.language === lang && r.voice === voice);
    const totalWords = rs.reduce((n, r) => n + words(r.said).length, 0);
    const errors = rs.reduce((n, r) => n + r.wer * words(r.said).length, 0);
    return `| ${lang} | ${voice} | ${rs.length} | ${pct(totalWords ? errors / totalWords : 0)} | ${pct(rs.filter((r) => r.wer === 0).length / Math.max(rs.length, 1))} |`;
  };
  const md = [
    `# The chat bar by voice, ${date}`,
    '',
    `Generated by \`scripts/chat/voice-asr.mjs\`: ${rows.length} prompts of \`test/chat-eval/prompts.json\` spoken by macOS voices (pt-BR Luciana and Eddy, es-MX Paulina and Eddy, en-US Samantha and Eddy, alternating in each language), transcribed by ${label} at \`${url}\` with "Perform ASR in <language>." in the prompt's own language. A handle is said as its name. The word error rate is over the words said, after case, accents and punctuation are dropped, so "\\$20" against "20 dollars" or "para o" against "pro" still count as errors; whether a transcript still routes right is measured by \`test/chat.eval.test.ts\` with \`CHAT_EVAL_PROMPTS\`. Synthetic speech: clean, one voice per clip, no noise; real voices will do worse. The real-time factor is the transcription's time over the clip's length.`,
    '',
    '## Summary',
    '',
    '| Language | Prompts | Word error rate | Exact | Median clip (s) | Median transcription (ms) | Real-time factor | Errors |',
    '|---|---|---|---|---|---|---|---|',
    summary('pt'),
    summary('es'),
    summary('en'),
    summary(null),
    '',
    'The robotic voices (Eddy) are a harder test than a person; the classic voices are closer to real speech, though cleaner.',
    '',
    '| Language | Voice | Prompts | Word error rate | Exact |',
    '|---|---|---|---|---|',
    ...Object.entries(VOICES).flatMap(([lang, vs]) => vs.map((v) => byVoice(lang, v))),
    '',
    '## Every prompt',
    '',
    '| Prompt | Voice | Said | Heard | WER | ms |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${cell(r.voice)} | ${cell(r.said)} | ${cell(r.error ? `error: ${r.error}` : r.heard)} | ${pct(r.wer)} | ${Math.round(r.ms)} |`),
    '',
  ].join('\n');
  const reportPath = join(outDir, `voice-${date}-${slug}.md`);
  writeFileSync(reportPath, md);

  // The prompt set the chat evaluation routes: each text replaced by what the model heard; a failed
  // transcription routes as "(no transcript)", a miss, never as the typed text.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const transcripts = JSON.parse(readFileSync(join(root, 'test', 'chat-eval', 'prompts.json'), 'utf8'))
    .filter((p) => byId.has(p.id))
    .map((p) => ({ ...p, text: byId.get(p.id).heard || '(no transcript)' }));
  const transcriptsPath = join(tmpdir(), `cofferdam-voice-prompts-${date}-${slug}.json`);
  writeFileSync(transcriptsPath, JSON.stringify(transcripts, null, 2) + '\n');
  console.log(`report: ${reportPath}\ntranscripts: ${transcriptsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
