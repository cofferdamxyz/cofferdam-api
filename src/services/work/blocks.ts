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
 * Characters that show nothing a reviewer would read as text: controls other
 * than tab and newlines, format characters (zero-width spaces and joiners,
 * bidirectional marks and overrides, the soft hyphen, the interlinear
 * annotation marks), the combining grapheme joiner, Mongolian and other
 * variation selectors, Hangul and braille fillers, and Unicode tags and the
 * supplementary variation selectors (U+E0000 onwards). Each can carry text a
 * model reads and the person who approved the block never saw. Two forms are
 * how emoji are written and pass: a joiner between two pictographs, and one
 * text or emoji selector (U+FE0E, U+FE0F) after a character.
 */
const FORMAT = /\p{Cf}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;

function hasHiddenCharacters(text: string): boolean {
  const cps = Array.from(text, (ch) => ch.codePointAt(0)!);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (c < 0x20 ? c !== 0x09 && c !== 0x0a && c !== 0x0d : c >= 0x7f && c <= 0x9f) return true;
    if (c >= 0xfe00 && c <= 0xfe0f) {
      const prev = cps[i - 1];
      if (c < 0xfe0e || prev == null || (prev >= 0xfe00 && prev <= 0xfe0f)) return true;
      continue;
    }
    if (c === 0x200d && isEmojiJoin(cps, i)) continue;
    if (c === 0x034f || (c >= 0x180b && c <= 0x180f) || c === 0x115f || c === 0x1160 || c === 0x2800 || c === 0x3164 || c === 0xffa0) return true;
    if (c >= 0xe0000 && c <= 0xe0fff) return true;
    if (FORMAT.test(String.fromCodePoint(c))) return true;
  }
  return false;
}

/** A zero-width joiner inside an emoji: a pictograph, its skin tone or its selector before, a pictograph after. */
function isEmojiJoin(cps: readonly number[], i: number): boolean {
  const before = cps[i - 1];
  const after = cps[i + 1];
  if (before == null || after == null) return false;
  const b = String.fromCodePoint(before);
  return (PICTOGRAPH.test(b) || EMOJI_MODIFIER.test(b) || before === 0xfe0f) && PICTOGRAPH.test(String.fromCodePoint(after));
}

// Every pattern below is bounded or unambiguous, so a crafted 4,000-character
// block scans in milliseconds: an unbounded spelled-email pattern took minutes
// (review round 3, 2026-10-24), and `test/workFixtures.test.ts` times them.

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}/;
/**
 * An address without its ending ("joao@gmail", "joao@gmail .com"). The host
 * starts with a letter, so a rating ("480V@60Hz") and the inclusive "un@"
 * pass.
 */
const EMAIL_PARTIAL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z][A-Za-z0-9-]{1,62}/;
/** A big mail host after "@" or "at" with spaces around it, on folded text: "joao.silva @ gmail", "joao at hotmail". */
const EMAIL_AT_HOST = /[a-z0-9._%+-]{2,64}[ \t]{0,3}(?:@|\b(?:at|arroba)\b)[ \t]{0,3}(?:gmail|googlemail|hotmail|outlook|yahoo|icloud|aol|uol|bol|protonmail|proton|ymail)\b/;
/** An address spelled out, on folded text: "joao at gmail dot com", "joao arroba gmail ponto com", "joao (at) gmail (dot) com". */
const EMAIL_SPELLED =
  /\b[a-z0-9._-]{2,64}[ \t]{0,3}(?:[[(<{][ \t]{0,3})?(?:at|arroba)(?:[ \t]{0,3}[\])>}])?[ \t]{0,3}[a-z0-9-]{2,63}[ \t]{0,3}(?:[[(<{][ \t]{0,3})?(?:dot|ponto|punto)(?:[ \t]{0,3}[\])>}])?[ \t]{0,3}(?:com|net|org|edu|gov|br|mx|es|pt|io|co|me)\b/;

const URL_SCHEME = /\b(?:https?:\/\/|www\.)\S/i;
const TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'ai', 'app', 'dev', 'co', 'me', 'tv', 'ly', 'gg', 'to', 'ee', 'page', 'site',
  'online', 'store', 'shop', 'tech', 'link', 'xyz', 'club', 'blog', 'pro', 'art', 'work', 'design', 'studio', 'live', 'digital',
  'website', 'services', 'solutions', 'company', 'agency', 'team', 'tools', 'works', 'cloud', 'construction', 'contractors',
  'plumbing', 'repair', 'cleaning',
  // Link-in-bio and short-link hosts: lnk.bio, taplink.cc, msha.ke, is.gd, goo.gl, bit.ly, t.me, wa.me.
  'bio', 'cc', 'ke', 'gd', 'gl', 'gy', 'is', 'sh', 'so', 'fm',
  'us', 'uk', 'ca', 'br', 'mx', 'es', 'pt', 'ar', 'cl', 'pe', 've', 'uy', 'lat', 'eu', 'de', 'fr', 'it', 'nl', 'be', 'ch', 'at',
  'se', 'no', 'dk', 'fi', 'pl', 'ru', 'in', 'cn', 'jp', 'au', 'nz', 'za',
];
/** A bare domain, ending wherever the next character cannot continue it: "joaosilva.com.", "joaosilva.com|IG". */
const DOMAIN = new RegExp(`\\b[a-z0-9][a-z0-9-]{0,62}\\.(?:${TLDS.join('|')})(?:\\.[a-z]{2})?(?:\\/\\S*)?(?![a-z0-9_])`, 'gi');
/** The all-capitals form that looks like a domain and is a skill: "ASP.NET", "VB.NET". */
const DOTNET_SKILL = /^[A-Z]{2,6}\.NET$/;
/**
 * Two sentences with no space between them, told by the word after the dot:
 * a capitalised word that is also a top-level domain ("Foreman.In 2019",
 * "equipe.No projeto", "the pump.So I"). "joaosilva.Com" is still a domain.
 */
const SENTENCE_JOIN = /^[A-Za-z0-9-]+\.(?:In|It|At|Is|So|No|De|Se|Es|Me|To|Be)$/;
/** An abbreviation before "de" in a title or a company form: "Aux.de Produção", "Op.de Máquinas", "S.A.de C.V.", "S.de R.L.". */
const ABBREVIATION_DE = /^[A-Za-z]{1,4}\.de$/;
/** A Brazilian company form after the name: "Ltda.ME", "EIRELI.EPP". */
const COMPANY_FORM = /^(?:ltda|eireli)\.(?:me|epp)$/i;
/** Tools named like a domain that a CV lists as skills, compared in lower case. */
const PRODUCTS = new Set(['socket.io', 'draw.io', 'diagrams.net', 'asp.net', 'vb.net', 'ado.net']);
/**
 * A domain written around its dot, on folded text: "joaosilva[.]com", or the
 * word form "joaosilva dot com", "joaosilva ponto com br", which must end its
 * phrase, since "ponto com" is also Portuguese ("cada ponto com eletroduto").
 */
const DOMAIN_SPELLED =
  /\b[a-z0-9][a-z0-9-]{2,62}[ \t]{0,3}(?:\[\.\]|\(\.\)|\{\.\})[ \t]{0,3}(?:com|net|org|info|io|me|co|br|mx|app|dev|xyz|site|online|store|shop|pro)\b|\b[a-z0-9][a-z0-9-]{2,62} (?:dot|ponto|punto) (?:com|net|org|br|mx|io)(?: (?:dot|ponto|punto) [a-z]{2})?(?=[ \t]{0,3}(?:$|[.,;:!?)\]/]))/;
/** A domain with spaces around its dot, in lower case: a sentence that ends before "Com" is capitalised. */
const DOMAIN_SPACED = /\b[a-z0-9][a-z0-9-]{2,62} \. (?:com|net|org)\b/;

/** A bare domain such as `linkedin.com/in/x` or `linktr.ee/x`, in any case. */
function hasDomain(text: string): boolean {
  for (const m of text.matchAll(DOMAIN)) {
    const host = m[0].split('/')[0]!;
    if (DOTNET_SKILL.test(host) || PRODUCTS.has(host.toLowerCase())) continue;
    if (SENTENCE_JOIN.test(m[0]) || ABBREVIATION_DE.test(m[0]) || COMPANY_FORM.test(m[0])) continue;
    return true;
  }
  return false;
}

/**
 * "@" not glued to a word (an email has already been refused) naming
 * something: "@joao", "“@joao”", "IG|@joao". A time is no handle: "@3pm",
 * "@ 10h".
 */
const HANDLE = /(?<![A-Za-z0-9_])@(?!\s?\d{1,2}(?::\d{2})?\s?(?:am|pm|h|hrs?)\b)(?=[A-Za-z0-9_.]*[A-Za-z])[A-Za-z0-9_][A-Za-z0-9_.]*/i;
const NETWORKS = 'instagram|insta|ig|facebook|fb|twitter|tiktok|linkedin|skype|telegram|whatsapp|zap|wpp|youtube|snapchat|discord|github|gitlab|kwai|wechat';
/**
 * A network's name with a value that ends its item, on folded text:
 * "Instagram: joaosilva", "IG | joaosilva", "Instagram - joao_soldas",
 * "linkedin /in/joao", or with only a space before a value shaped like a
 * handle ("Instagram joao_soldas"). "Instagram: Reels and Stories" is a skill.
 */
const SOCIAL_LABEL = new RegExp(
  `\\b(?:${NETWORKS})(?:[ \\t]{0,3}[:=|/]|[ \\t][-\u2013\u2014])[ \\t]{0,3}[a-z0-9_.@/-]{2,64}(?=[ \\t]{0,3}(?:$|[,;|()\\]\\n]))` +
    `|\\b(?:${NETWORKS})[ \\t](?=[a-z0-9_.]{0,63}[_.\\d])[a-z0-9_.]{3,64}(?=[ \\t]{0,3}(?:$|[,;|()\\]\\n]))`,
);

// Field labels of personal data, matched on lower-case text with accents
// folded: "CPF:", "RG nº:", "Data de nascimento:", "Estado civil:", "Passport
// No." A label with a value is a personal block the phone should have kept.
// Not "CNH": a driving-licence category is a qualification, and its number is
// a long number anyway.
const PERSONAL_LABEL = /\b(?:cpf|rg|ssn|curp|rfc|nss|dni|ctps|pis|nif|nie|dob|itin)\b\s*(?:n[o.º°]*\s*)?[:#]/;
const PERSONAL_FIELD =
  /\b(?:date of birth|birth ?date|data de nascimento|fecha de nacimiento|estado civil|marital status|nacionalidade|nacionalidad|nationality|naturalidade|filiacao|idade|edad|sexo|genero|gender)\s*:/;
/** A birth date without its colon: "Data de nascimento 15/03/1985", "born on 03/15/1985". */
const BIRTH_DATE = /\b(?:date of birth|birth ?date|born on|data de nascimento|nascid[oa] em|fecha de nacimiento|nacid[oa] el)\s{0,3}\d/;
const PASSPORT_NUMBER = /\b(?:passport|passaporte|pasaporte)\s*(?:no\b|nr\b|number|numero|#|n\.)/;

// Identity numbers that are not runs of digits, read in capitals: a Mexican
// CURP (also with spaces between its parts) or RFC, and any code of seven or
// more letters and digits with five digits in a row ("X1234567",
// "AB-1234567"). A standard is not one ("ISO-27001", "IEC-61131-3"), and
// neither is a quantity glued to its unit ("10000PSI", "50000M2").
const CURP = /\b[A-Z][AEIOUX][A-Z]{2}\s?\d{6}\s?[HM][A-Z]{5}\s?[A-Z0-9]\s?\d\b/;
const RFC = /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/;
const ALNUM_ID = /\b(?=[A-Z0-9-]{0,59}\d{5})(?=[A-Z0-9-]{0,63}[A-Z])[A-Z0-9-]{7,64}\b/g;
const STANDARD = /^(?:ISO|IEC|EN|NBR|ABNT|ASTM|ASME|API|NFPA|IEEE|DIN|BS|AWS|ANSI|UL|NOM|NMX)-?\d/;
const QUANTITY = /^\d+[A-Z]{1,4}[23]?$/;

function hasIdCode(text: string): boolean {
  const upper = text.toUpperCase();
  if (CURP.test(upper) || RFC.test(upper)) return true;
  for (const m of upper.matchAll(ALNUM_ID)) if (!STANDARD.test(m[0]) && !QUANTITY.test(m[0])) return true;
  return false;
}

// Digits joined, on a line or across one, by spaces, dots, brackets, slashes,
// dashes of any kind or underscores, or by a middle dot or bullet with no
// space around it ("713•555•0142"; "120 • 300" is a list). Seven digits or
// more that are not a date are a phone, CPF, SSN, card, postal or licence
// number.
//  - A run splits at a spaced dash or a line break: a range, or the next line.
//  - A segment is a date when its groups are years (1950 to 2039) beside one-
//    or two-digit groups ("03/2019"), or short dates ("03/19", "15/03/19"),
//    one or two to a segment.
//  - The other segments count all their digits, summed over the run, so a
//    number wrapped across lines counts whole ("555-\n0142"). Dates count too
//    when the rest of the run holds five digits or more, so a phone with a
//    group that reads like a year still counts ("(11) 3456 - 2019"); beside a
//    count, a date is a range ("2016 – 2019 – 300 obras").
//  - Not counted: a standard's own first group ("ISO 9001 2015"), an OSHA
//    section ("1910.147", "29 CFR 1926.501"), and an amount in groups of
//    three beside its currency or unit ("R$ 1.200.000", "1.200.000 reais",
//    "1.200.000 m³").
const DIGIT_RUN = /\+?\d(?:(?:[\s().\-/_\u2010-\u2015\u2212]|(?<=\d)[\u00b7\u2022\u2219\u2027](?=\d))*\d)+/g;
const RANGE_SPLIT = /\s+[-\u2010-\u2015\u2212]\s*|\s*[-\u2010-\u2015\u2212]\s+|\s*[\n\r\u2028\u2029]\s*/;
const DASH = /[-\u2010-\u2015\u2212]/;
const LONG_NUMBER_DIGITS = 7;
const STANDARD_BEFORE = /\b(?:ISO|IEC|EN|NBR|ABNT|ASTM|ASME|API|NFPA|IEEE|DIN|BS|AWS|ANSI|UL|NOM|NMX)[\s-]*$/;
const OSHA_SECTION = /^19(?:04|10|15|17|18|26|28)\.\d{1,4}$/;
const CURRENCY_BEFORE = /(?:R\$|US\$|MX\$|\$|€|£|USD|BRL|MXN|EUR)\s*$/i;
const CURRENCY_OR_UNIT_AFTER =
  /^\s*(?:reais|real|pesos?|d[oó]lares|dollars?|euros?|usd|brl|mxn|eur|m[²³23]?|metros|meters|metres|km|kg|t|tons?|toneladas|l|litros|liters|litres|gal|gallons|lbs?|kw|kwh|mw|mwh|btu|psi|bar|hp|cv|rpm)(?![A-Za-z])/i;
const GROUPED_AMOUNT = /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?$/;
const SHORT_DATE = /^\D*(?:(?:0?[1-9]|[12]\d|3[01])\/)?(?:0?[1-9]|1[0-2])\/\d{2}\D*$/;
/** A toll-free number with letters: "1-800-PLUMBER". */
const VANITY_NUMBER = /\b1[-. ]?8(?:00|33|44|55|66|77|88)[-. ]?[A-Z0-9]{3}[-. ]?[A-Z0-9]{4}\b/;

function isYear(group: string): boolean {
  if (group.length !== 4) return false;
  const y = Number(group);
  return y >= 1950 && y <= 2039;
}

function isYearDate(part: string): boolean {
  const groups = part.match(/\d+/g) ?? [];
  return groups.some(isYear) && groups.every((g) => isYear(g) || g.length <= 2);
}

/** A date, or a range of two dates written with an unspaced dash ("2016-2020", "03/19-05/21"). */
function isDateSegment(segment: string): boolean {
  if (isYearDate(segment)) return true;
  const parts = segment.split(DASH);
  return parts.length <= 2 && parts.every((p) => isYearDate(p) || SHORT_DATE.test(p));
}

function hasLongNumber(text: string): boolean {
  if (VANITY_NUMBER.test(text)) return true;
  for (const m of text.matchAll(DIGIT_RUN)) {
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (OSHA_SECTION.test(m[0])) continue;
    // After a standard's name, its own first group is its number ("ISO 9001 2015"); a longer run is not a standard's.
    const run = STANDARD_BEFORE.test(before) ? m[0].replace(/^\d{1,5}(?!\d)[\s-]*/, '') : m[0];
    const segments = run.split(RANGE_SPLIT);
    const last = segments.length - 1;
    let other = 0;
    let dates = 0;
    segments.forEach((segment, k) => {
      const amount = GROUPED_AMOUNT.test(segment) && ((k === 0 && CURRENCY_BEFORE.test(before)) || (k === last && CURRENCY_OR_UNIT_AFTER.test(after)));
      if (amount) return;
      const digits = segment.replace(/\D/g, '').length;
      if (isDateSegment(segment)) dates += digits;
      else other += digits;
    });
    if (other + (other >= 5 ? dates : 0) >= LONG_NUMBER_DIGITS) return true;
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
  // Compatibility forms fold first: full-width digits, "＠" and "．", a
  // non-breaking hyphen or space read as their plain forms, and an
  // ideographic full stop as a dot.
  const t = text.normalize('NFKC').replace(/[\u3002\ufe12]/g, '.').replace(new RegExp(PLACEHOLDER_SOURCE, 'g'), ' ');
  const folded = fold(t);
  if (EMAIL.test(t) || EMAIL_PARTIAL.test(t) || EMAIL_AT_HOST.test(folded) || EMAIL_SPELLED.test(folded)) return 'email';
  if (URL_SCHEME.test(t) || hasDomain(t) || DOMAIN_SPELLED.test(folded) || DOMAIN_SPACED.test(t)) return 'url';
  if (HANDLE.test(t) || SOCIAL_LABEL.test(folded)) return 'handle';
  if (PERSONAL_LABEL.test(folded) || PERSONAL_FIELD.test(folded) || BIRTH_DATE.test(folded) || PASSPORT_NUMBER.test(folded)) return 'personal_field';
  if (hasIdCode(t)) return 'id_number';
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
