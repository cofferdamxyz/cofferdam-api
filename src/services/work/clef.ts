// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Clef in the Work pipeline (workspace decision 0005, `docs/product/engine.md`,
 * Decision layer). Clef answers typed questions about a state with a
 * probability per option and writes no text: `choice` picks one of named
 * criteria, `noul` answers yes or no, `score` places the state on an ordered
 * legend. It never writes a field, a token or a code.
 *
 * The readers here fail closed: a missing or malformed answer reads as
 * undecided, never as a default yes or a default choice, and a choice counts
 * only at or above its floor.
 */

import type { DeidentifiedBlock } from './blocks.js';

export interface ClefChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option key to its description; the key is what comes back. */
  criteria: Record<string, string>;
}

export interface ClefNoulQuestion {
  type: 'noul';
  instructions: string;
}

export interface ClefScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered levels, lowest first. */
  criteria: readonly string[];
}

export type ClefQuestion = ClefChoiceQuestion | ClefNoulQuestion | ClefScoreQuestion;

/** The name Clef's request body carries (`clef-flash` for `@cf/cloudflare/clef-flash`). */
export function clefModelName(model: string): string {
  return model.split('/').pop() ?? model;
}

/** The request body for one Clef call. */
export function clefInput(model: string, state: string, questions: Record<string, ClefQuestion>) {
  return { model: clefModelName(model), state, questions };
}

function answerOf(result: unknown, id: string): Record<string, unknown> | null {
  const answers = (result as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') return null;
  const a = (answers as Record<string, unknown>)[id];
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : null;
}

const probability = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

export interface ChoiceReading<K extends string> {
  /** The chosen key, or null below the floor, outside the criteria, or without an answer. */
  choice: K | null;
  /** Clef's probability for its own choice, 0 when it gave none. */
  p: number;
  /** Every option's probability that came back, criteria keys only. */
  probabilities: Partial<Record<K, number>>;
}

/** Read a `choice` answer; `choice` is set only when Clef's pick is a criteria key with p ≥ floor. */
export function readChoice<K extends string>(result: unknown, id: string, keys: readonly K[], floor: number): ChoiceReading<K> {
  const a = answerOf(result, id);
  const probabilities: Partial<Record<K, number>> = {};
  const raw = a?.probabilities;
  if (raw && typeof raw === 'object') {
    for (const k of keys) {
      const p = probability((raw as Record<string, unknown>)[k]);
      if (p != null) probabilities[k] = p;
    }
  }
  const picked = typeof a?.choice === 'string' && (keys as readonly string[]).includes(a.choice) ? (a.choice as K) : null;
  const p = picked ? (probabilities[picked] ?? 0) : 0;
  return { choice: picked && p >= floor ? picked : null, p, probabilities };
}

/** Read a `noul` answer: the probability of yes, or null without one. */
export function readNoul(result: unknown, id: string): number | null {
  return probability(answerOf(result, id)?.noul);
}

/** Read a `score` answer on a legend of `levels` levels, as 0 to 1, or null without one. */
export function readScore(result: unknown, id: string, levels: number): number | null {
  const s = answerOf(result, id)?.score;
  if (typeof s !== 'number' || !Number.isFinite(s) || levels < 2) return null;
  return Math.round(Math.min(1, Math.max(0, s / (levels - 1))) * 1000) / 1000;
}

/** Input tokens a Clef call reported (it bills input only). */
export function clefInputTokens(result: unknown): number {
  const n = Number((result as { usage?: { input_tokens?: unknown } } | null)?.usage?.input_tokens);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// ── The document type (decision 0021 (d)) ───────────────────────────────────

/** What a Vault document can be; each type chooses its extraction schema. */
export const DOCUMENT_TYPES = {
  cv: 'A CV or résumé: work experience, skills, education, languages',
  certificate: 'A training or competence certificate: a course, its issuer, issue or expiry dates',
  licence: 'A professional or trade licence or permit issued by an authority',
  passport: 'A passport or a national identity document',
  other: 'Anything else: a contract, an invoice, a letter, a form',
} as const;

export type DocumentType = keyof typeof DOCUMENT_TYPES;
export const DOCUMENT_TYPE_KEYS = Object.keys(DOCUMENT_TYPES) as DocumentType[];

/** Below this the document is not classified and the phone asks the user. */
export const DOCUMENT_TYPE_FLOOR = 0.5;

/** At most this much text from the blocks reaches Clef (its window is 24,576 tokens with the questions). */
export const CLASSIFY_STATE_MAX_CHARS = 8_000;

export function documentQuestions(): Record<string, ClefQuestion> {
  return {
    document: {
      type: 'choice',
      instructions: 'What kind of document are these blocks from? Names were replaced by placeholders such as [ORG_1].',
      criteria: { ...DOCUMENT_TYPES },
    },
  };
}

/** The blocks as Clef's state: each labelled with its kind, cut to the state cap. */
export function documentState(blocks: readonly DeidentifiedBlock[]): string {
  return blocks
    .map((b) => `[${b.kind}]\n${b.text}`)
    .join('\n\n')
    .slice(0, CLASSIFY_STATE_MAX_CHARS);
}

// ── A hirer's intent (S5) ───────────────────────────────────────────────────

/** Where the work is done; the hirer confirms it on the card. */
export const SCOPE_CRITERIA = {
  onsite: 'Done in person, at a place the worker goes to',
  remote: 'Done from anywhere, online or by phone',
} as const;
export type IntentScope = keyof typeof SCOPE_CRITERIA;
export const SCOPE_KEYS = Object.keys(SCOPE_CRITERIA) as IntentScope[];
/** Below this the scope is on-site, the safer default: it never widens a job to the world. */
export const SCOPE_FLOOR = 0.5;
/** A registry token the task needs counts at or above this. */
export const NEED_FLOOR = 0.5;

export interface NeedCandidate {
  token: string;
  /** Its English name, as Clef reads it. */
  label: string;
  kind: 'pos' | 'skill';
}

/**
 * One Clef call for an intent: the scope as a `choice`, and one `noul` per
 * nearby registry token ("does the job need a plumber?"), so the tokens the
 * gate requires are chosen among the registry's, never written by a model.
 */
export function intentQuestions(candidates: readonly NeedCandidate[]): Record<string, ClefQuestion> {
  const questions: Record<string, ClefQuestion> = {
    scope: { type: 'choice', instructions: 'Where is this job done?', criteria: { ...SCOPE_CRITERIA } },
  };
  candidates.forEach((c, i) => {
    questions[`need_${i}`] = {
      type: 'noul',
      instructions: c.kind === 'pos' ? `Does this job need a ${c.label}?` : `Does this job need someone who can do ${c.label}?`,
    };
  });
  return questions;
}

export function intentState(sentence: string, lang: string): string {
  return `A hirer wrote this request, in ${lang}:\n${sentence}`;
}
