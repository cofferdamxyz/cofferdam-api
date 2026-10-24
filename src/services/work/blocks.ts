// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The cloud executor's block protocol (workspace decisions 0020 and 0021,
 * `docs/product/engine.md`, Parser). The phone runs OCR, splits a document
 * into blocks, replaces every identifying string with a placeholder
 * (`[ORG_1]`, `[PLACE_2]`), keeps the header, contact, references and
 * personal blocks on the phone, and sends the rest to the plane one block per
 * request. No image, PDF or raw OCR text reaches the plane or a hosted model,
 * the placeholder map never leaves the phone, and nothing on the plane ties
 * two blocks of one document together.
 *
 * `checkBlock` is the plane's re-check before any hosted call. It is a
 * tripwire for what the phone's de-identification missed, not a detector of
 * its own: it cannot find a name, which only the phone can replace. It fails
 * closed. A block with an email address, a URL, a handle, a personal-data
 * field, an identity or phone number, hidden characters, or a kind that must
 * stay on the phone is refused with a reason code, and its text is never
 * logged or echoed. Only a block that passes becomes a `DeidentifiedBlock`,
 * the one type the extraction op accepts.
 */

/** The CV sections the cloud executor extracts, one block each (an experience or education block is one entry). */
export const CV_BLOCK_KINDS = ['summary', 'experience', 'education', 'skills', 'certificates', 'languages'] as const;
export type CvBlockKind = (typeof CV_BLOCK_KINDS)[number];

/**
 * Block kinds that may leave the phone on the cloud path: the CV sections,
 * and `body`, a de-identified block the phone's heading lexicon could not
 * place (a certificate, a licence), which only the document classification
 * reads; no extraction schema takes it.
 */
export const CLOUD_BLOCK_KINDS = [...CV_BLOCK_KINDS, 'body'] as const;
export type CloudBlockKind = (typeof CLOUD_BLOCK_KINDS)[number];

/** Kinds that never leave the phone; the plane refuses them by name. */
export const DEVICE_ONLY_BLOCK_KINDS = ['header', 'contact', 'references', 'personal'] as const;

/** The languages the pipeline is built and evaluated for: en-US, pt-BR and es-MX. */
export const BLOCK_LANGS = ['en', 'pt', 'es'] as const;
export type BlockLang = (typeof BLOCK_LANGS)[number];

/**
 * What the phone writes in place of an identifying string, numbered per
 * document: `[ORG_1]` is the first organisation, `[PLACE_2]` the second place.
 * The parser writes the first five; the chat's on-device privacy gate
 * (`cofferdam-app` `src/lib/privacyGate.ts`, decision 0024), which a hirer's
 * typed sentence also passes, writes `ID` and the rest. The map back to the
 * real strings exists only on the phone and in the client-encrypted Vault.
 */
export const PLACEHOLDER_CLASSES = ['ORG', 'PLACE', 'PERSON', 'VESSEL', 'ID', 'EMAIL', 'PHONE', 'LINK', 'CARD', 'IBAN', 'ACCOUNT', 'DOC'] as const;
export type PlaceholderClass = (typeof PLACEHOLDER_CLASSES)[number];
const PLACEHOLDER_SOURCE = String.raw`\[(${PLACEHOLDER_CLASSES.join('|')})_([1-9]\d?)\]`;

/** A whole string that is exactly one placeholder of the given classes. */
export function isPlaceholder(value: string, classes: readonly PlaceholderClass[] = PLACEHOLDER_CLASSES): boolean {
  const m = new RegExp(`^${PLACEHOLDER_SOURCE}$`).exec(value);
  return m != null && (classes as readonly string[]).includes(m[1]!);
}

/** The placeholders a text carries, in order of appearance. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'g'))].map((m) => m[0]);
}

declare const deidentified: unique symbol;

/** A block that passed `checkBlock`; nothing else can be one. */
export interface DeidentifiedBlock {
  readonly kind: CloudBlockKind;
  readonly lang: BlockLang;
  /** NFC-normalized; extracted spans are checked against exactly this text. */
  readonly text: string;
  readonly [deidentified]: true;
}

export type BlockRefusal =
  | 'bad_shape'
  | 'kind_not_allowed'
  | 'lang_not_supported'
  | 'empty'
  | 'too_long'
  | 'hidden_characters'
  | 'email'
  | 'url'
  | 'handle'
  | 'personal_field'
  | 'id_number'
  | 'long_number';

/** About 700 tokens is a typical block (engine.md, Cost); the cap leaves room for a long one. */
export const BLOCK_MAX_CHARS = 4_000;

export type BlockCheck = { ok: true; block: DeidentifiedBlock } | { ok: false; reason: BlockRefusal };

/**
 * Control characters other than tab and newlines, bidirectional overrides and
 * zero-width characters: none belongs in a CV block, and each can hide text
 * from the person who reviewed what leaves the phone.
 */
function hasHiddenCharacters(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff) return true;
  }
  return false;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_SCHEME = /\b(?:https?:\/\/|www\.)\S/i;
const DOMAIN =
  /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|io|xyz|me|co|dev|app|link|page|site|online|br|mx|us|uk|es|pt|ar|cl)(?:\.[a-z]{2})?(?:\/\S*)?(?=[\s,;:)\]]|$)/gi;
const HANDLE = /(?:^|[\s(])@[A-Za-z0-9_][A-Za-z0-9_.]+/;

/** A bare domain such as `linkedin.com/in/x`; an all-capitals name such as "ASP.NET" is a skill, not an address. */
function hasDomain(text: string): boolean {
  for (const m of text.matchAll(DOMAIN)) if (m[0] !== m[0].toUpperCase()) return true;
  return false;
}

// Field labels of personal data, matched on lower-case text with accents
// folded: "CPF:", "RG nº:", "Data de nascimento:", "Estado civil:", "Passport
// No." A label with a value is a personal block the phone should have kept.
// Not "CNH": a driving-licence category is a qualification, and its number is
// a long number anyway.
const PERSONAL_LABEL = /\b(?:cpf|rg|ssn|curp|rfc|nss|dni|ctps|pis|nif|nie|dob|itin)\b\s*(?:n[o.º°]*\s*)?[:#]/;
const PERSONAL_FIELD =
  /\b(?:date of birth|birth ?date|data de nascimento|fecha de nacimiento|estado civil|marital status|nacionalidade|nacionalidad|nationality|naturalidade|filiacao|idade|edad|sexo|genero|gender)\s*:/;
const PASSPORT_NUMBER = /\b(?:passport|passaporte|pasaporte)\s*(?:no\b|nr\b|number|numero|#|n\.)/;

// Identity numbers that are not runs of digits: a Mexican CURP or RFC, and any
// code of seven or more letters and digits with five digits in a row
// ("X1234567", "AB-1234567").
const CURP = /\b[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/;
const RFC = /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/;
const ALNUM_ID = /\b(?=[A-Z0-9-]*\d{5})(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{7,}\b/;

// Digits joined by spaces, dots, dashes, slashes or brackets: a phone, CPF,
// SSN, card or licence number has seven or more of them. Dates are allowed:
// a run made only of years (1950-2039) and one- or two-digit numbers, with at
// least one year ("03/2019 - 05/2021", "2015-2019").
const DIGIT_RUN = /\+?\d(?:[\s().\-/]*\d)+/g;
const LONG_NUMBER_DIGITS = 7;

function isDateRun(run: string): boolean {
  const groups = run.match(/\d+/g) ?? [];
  let years = 0;
  for (const g of groups) {
    if (g.length === 4) {
      const y = Number(g);
      if (y < 1950 || y > 2039) return false;
      years++;
    } else if (g.length > 2) {
      return false;
    }
  }
  return years > 0;
}

function hasLongNumber(text: string): boolean {
  for (const m of text.matchAll(DIGIT_RUN)) {
    const digits = m[0].replace(/\D/g, '').length;
    if (digits >= LONG_NUMBER_DIGITS && !isDateRun(m[0])) return true;
  }
  return false;
}

/** Lower case with accents folded ("nº" reads "no", "Março" reads "marco"), for checks and lexicons. */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * The content tripwires, shared by CV blocks and a hirer's sentence. Returns
 * the first reason found, or null. Placeholders are blanked first, so
 * `[ID_1]` is never read as a number.
 */
export function scanText(text: string): BlockRefusal | null {
  if (hasHiddenCharacters(text)) return 'hidden_characters';
  const t = text.replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), ' ');
  if (EMAIL.test(t)) return 'email';
  if (URL_SCHEME.test(t) || hasDomain(t)) return 'url';
  if (HANDLE.test(t)) return 'handle';
  const folded = fold(t);
  if (PERSONAL_LABEL.test(folded) || PERSONAL_FIELD.test(folded) || PASSPORT_NUMBER.test(folded)) return 'personal_field';
  if (CURP.test(t) || RFC.test(t) || ALNUM_ID.test(t)) return 'id_number';
  if (hasLongNumber(t)) return 'long_number';
  return null;
}

/** The plane's re-check of one block from the phone; see the module comment. */
export function checkBlock(input: unknown): BlockCheck {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'bad_shape' };
  const { kind, lang, text } = input as Record<string, unknown>;
  if (typeof kind !== 'string' || typeof lang !== 'string' || typeof text !== 'string') return { ok: false, reason: 'bad_shape' };
  if (!(CLOUD_BLOCK_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: 'kind_not_allowed' };
  if (!(BLOCK_LANGS as readonly string[]).includes(lang)) return { ok: false, reason: 'lang_not_supported' };
  const normalized = text.normalize('NFC').trim();
  if (!normalized) return { ok: false, reason: 'empty' };
  if (normalized.length > BLOCK_MAX_CHARS) return { ok: false, reason: 'too_long' };
  const refused = scanText(normalized);
  if (refused) return { ok: false, reason: refused };
  return { ok: true, block: { kind, lang, text: normalized } as unknown as DeidentifiedBlock };
}
