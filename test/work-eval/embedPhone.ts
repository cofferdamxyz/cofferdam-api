// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The phone-vs-Mac check of the v2 embedder (workspace decision 0068, the
 * open item before the switch): every kind of text the Work routes will take,
 * embedded by each phone's app (the reader benchmark's embed mode, cofferdam-app
 * `src/lib/localAi/readerBench.ts`) and by the Mac with the same pinned file
 * (`macEmbed`), compared vector by vector and by the decisions the vectors
 * feed. `test/workEmbedPhone.eval.test.ts` writes the plan and scores the
 * results; this module builds the texts and holds the pure scoring.
 *
 * The texts, synthetic or public (no real resume), about 2,400:
 *   1. registry labels across kinds, languages and the US layer, as
 *      documents: the phone's vector against the stored v2 vector;
 *   2. claim strings as CVs and listings carry them (the synthetic CVs'
 *      fields, the tier-2 floor's listings, the locale cases), with
 *      misspellings, abbreviations and local names, each as a query (the
 *      snap) and as a document (what a mint stores);
 *   3. listing texts built by `listingText`, from one claim to the most a
 *      draft allows;
 *   4. hirer sentences in English, Portuguese and Spanish, from a few words
 *      to `INTENT_MAX_CHARS`;
 *   5. awkward texts: white space, decomposed accents, ligatures, no-break
 *      spaces, curly quotes and dashes, emoji, capitals, dates and numbers,
 *      and texts past the embedder's 1,024 tokens.
 * A listing's English names are registry labels drawn at random: the check
 * compares two embedders on the same texts, so which names a snap would
 * give changes nothing.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INTENT_MAX_CHARS } from '../../src/services/work/intent.js';
import { DRAFT_LIMITS, listingText, type ListingDraft } from '../../src/services/work/listings.js';
import { ADJUDICATION_CANDIDATES } from '../../src/services/work/registry.js';

export type Role = 'query' | 'document';

/**
 * A text this long (in characters) may pass the embedder's 1,024 tokens: the plan puts such texts last, so a phone
 * the system ends on one has embedded every other set; the Mac embeds each alone, and the app writes its file around
 * each (cofferdam-app `readerBench.ts`).
 */
export const LONG_TEXT_CHARS = 2_500;
export type TextSet = 'label' | 'claim' | 'listing' | 'sentence' | 'awkward';
export type ClaimKind = 'pos' | 'skill' | 'cert';

/** One text of the plan, as the app's embed mode reads it. */
export interface PlanText {
  id: string;
  text: string;
  role: Role;
}

/** What the scorer knows of each text; the plan's own copy stays on the Mac (`meta.json`). */
export interface TextMeta {
  id: string;
  set: TextSet;
  role: Role;
  chars: number;
  kind?: ClaimKind;
  lang?: string;
  /** A label's row in the v2 replica's cache (`bench-cache/v2-768.*`), whose stored vector the phone's must match. */
  row?: number;
  /** An awkward text: what changed, its clean form's id, and whether the plane holds the two as one text. */
  change?: string;
  cleanId?: string;
  planeSame?: boolean;
}

/** A row of the replica's cache (`bench-cache/v2-768.meta.json`). */
export interface ReplicaRow {
  id: string;
  token: string;
  kind: string;
  lang: string;
  label: string;
  source: string;
}

export interface EmbedPhonePlan {
  plan: {
    v: 1;
    source: string;
    runs: 1;
    cvs: [];
    readers: [];
    embed: { texts: PlanText[]; listing: { queries: string[]; documents: string[]; runs: number } };
  };
  meta: TextMeta[];
}

// ── Seeded choice ──────────────────────────────────────────────────────────

/** mulberry32: the same seed gives the same plan. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)]!;

function sample<T>(r: () => number, a: readonly T[], n: number): T[] {
  const copy = [...a];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

// ── The plane's own view of one text ───────────────────────────────────────

/** A claim as the plane snaps it (`registry.ts`): NFC, each run of white space one space, trimmed. */
export const planeClaim = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
/** A hirer's sentence as the plane takes it (`intent.ts`, `hire.ts`): NFC, trimmed. */
export const planeSentence = (s: string) => s.normalize('NFC').trim();
/** Whether the plane takes a claim at all: `checkDraft` measures the string as sent, before NFC, against `DRAFT_LIMITS.chars`. */
export const planeTakesClaim = (s: string) => s.length <= DRAFT_LIMITS.chars;
/** Whether the plane takes a sentence: `INTENT_MAX_CHARS` after NFC and the trim. */
export const planeTakesSentence = (s: string) => planeSentence(s).length > 0 && planeSentence(s).length <= INTENT_MAX_CHARS;

// ── 1. Registry labels ─────────────────────────────────────────────────────

/**
 * Labels across the cells the registry holds: each kind in English, Portuguese
 * and Spanish from ESCO, and the US layer (a row with a region); `perCell`
 * a cell, `us` from the US layer.
 */
export function sampleLabels(rows: readonly ReplicaRow[], regions: Readonly<Record<string, string>>, r: () => number, perCell = 80, us = 20): { row: number; kind: ClaimKind; lang: string }[] {
  const out: { row: number; kind: ClaimKind; lang: string }[] = [];
  for (const kind of ['pos', 'skill'] as const) {
    for (const lang of ['en', 'pt', 'es']) {
      const cell = rows.flatMap((x, i) => (x.kind === kind && x.lang === lang && !regions[i] ? [i] : []));
      for (const i of sample(r, cell, perCell)) out.push({ row: i, kind, lang });
    }
  }
  const layer = rows.flatMap((x, i) => (regions[i] ? [i] : []));
  for (const i of sample(r, layer, us)) out.push({ row: i, kind: rows[i]!.kind === 'pos' ? 'pos' : 'skill', lang: rows[i]!.lang });
  return out;
}

// ── 2. Claims ──────────────────────────────────────────────────────────────

export interface Claim {
  text: string;
  kind: ClaimKind;
  lang: string;
  origin: 'cv' | 'listing' | 'locale' | 'long' | 'misspelt' | 'abbreviated' | 'local';
}

/** The claims the synthetic fixtures hold: the CVs' fields, the tier-2 floor's listings, the locale cases. */
export function fixtureClaims(fixtures: string): Claim[] {
  const out: Claim[] = [];
  const cvs = JSON.parse(readFileSync(join(fixtures, 'parse', 'cvs.json'), 'utf8')) as {
    cvs: { locale: string; truth: { headline?: { title?: string }; experience?: { title?: string }[]; skills?: string[]; certificates?: { name?: string }[] } }[];
  };
  for (const cv of cvs.cvs) {
    const lang = cv.locale.slice(0, 2);
    const t = cv.truth;
    if (t.headline?.title) out.push({ text: t.headline.title, kind: 'pos', lang, origin: 'cv' });
    for (const e of t.experience ?? []) if (e.title) out.push({ text: e.title, kind: 'pos', lang, origin: 'cv' });
    for (const s of t.skills ?? []) out.push({ text: s, kind: 'skill', lang, origin: 'cv' });
    for (const c of t.certificates ?? []) if (c.name) out.push({ text: c.name, kind: 'cert', lang, origin: 'cv' });
  }
  // A tier-2 listing's text is its titles, skills and certificates, each list joined by '; ', the lists by '. '.
  const floor = JSON.parse(readFileSync(join(fixtures, 'tier2-floor.json'), 'utf8')) as { listings: { lang: string; text: string }[] };
  for (const l of floor.listings) {
    const parts = l.text.split('. ');
    const kinds: ClaimKind[] = ['pos', 'skill', 'cert'];
    parts.slice(0, 3).forEach((p, i) => {
      for (const s of p.split('; ')) if (s.trim()) out.push({ text: s.trim(), kind: kinds[i]!, lang: l.lang, origin: 'listing' });
    });
  }
  const locale = JSON.parse(readFileSync(join(fixtures, 'locale-cases.json'), 'utf8')) as { cases: { kind: string; lang: string; raw: string }[] };
  for (const c of locale.cases) out.push({ text: c.raw, kind: c.kind === 'cert' ? 'cert' : c.kind === 'skill' ? 'skill' : 'pos', lang: c.lang, origin: 'locale' });
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)));
}

/** Two letters swapped inside a word, as a hurried CV writes them; null when the text has no word long enough. */
export function misspell(s: string, r: () => number): string | null {
  const spots: number[] = [];
  for (let i = 1; i + 2 < s.length; i++) if (/\p{L}/u.test(s[i]!) && /\p{L}/u.test(s[i + 1]!) && s[i] !== s[i + 1]) spots.push(i);
  if (!spots.length) return null;
  const i = pick(r, spots);
  return s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
}

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  engineer: 'Eng.',
  engenheiro: 'Eng.',
  engenheira: 'Eng.',
  ingeniero: 'Ing.',
  ingeniera: 'Ing.',
  technician: 'Tech.',
  técnico: 'Téc.',
  técnica: 'Téc.',
  assistant: 'Asst.',
  assistente: 'Assist.',
  asistente: 'Asist.',
  auxiliar: 'Aux.',
  manager: 'Mgr.',
  gerente: 'Ger.',
  supervisor: 'Supv.',
  supervisora: 'Supv.',
  operator: 'Op.',
  operador: 'Op.',
  maintenance: 'Maint.',
  manutenção: 'Manut.',
  mantenimiento: 'Mtto.',
  electrical: 'Elec.',
  elétrica: 'Elét.',
  eléctrica: 'Eléc.',
  industrial: 'Ind.',
  segurança: 'Seg.',
  seguridad: 'Seg.',
  administração: 'Adm.',
  administración: 'Admón.',
  senior: 'Sr.',
  junior: 'Jr.',
  department: 'Dept.',
  departamento: 'Depto.',
  certificate: 'Cert.',
  certificado: 'Cert.',
};

/** The words a CV shortens, shortened; null when none is in the text. */
export function abbreviate(s: string): string | null {
  let changed = false;
  const out = s.replace(/\p{L}+/gu, (w) => {
    const a = ABBREVIATIONS[w.toLowerCase()];
    if (!a) return w;
    changed = true;
    return a;
  });
  return changed ? out : null;
}

/** Job names as people say them in Brazil and Mexico, many of which the registry holds under another name. */
export const LOCAL_NAMES: readonly { text: string; kind: ClaimKind; lang: string }[] = [
  ...[
    'Peão de obra',
    'Ajudante de pedreiro',
    'Mestre de obras',
    'Motoboy',
    'Frentista',
    'Chapeiro',
    'Boia-fria',
    'Marreteiro',
    'Faz-tudo',
    'Diarista',
    'Babá folguista',
    'Cuidador de idosos',
    'Porteiro de condomínio',
    'Zelador',
    'Vigia noturno',
    'Operador de empilhadeira',
    'Soldador de tubulação',
    'Caldeireiro',
    'Encarregado de obra',
    'Auxiliar de serviços gerais',
    'Repositor de mercadorias',
    'Embalador',
    'Garçom',
    'Barista',
    'Confeiteira',
    'Manicure',
    'Cabeleireira',
    'Técnico de enfermagem',
    'Agente comunitário de saúde',
    'Motorista de aplicativo',
    'Caminhoneiro',
    'Despachante',
    'Office boy',
    'Estoquista',
    'Instalador de ar-condicionado',
  ].map((text) => ({ text, kind: 'pos' as const, lang: 'pt' })),
  ...['Albañil', 'Chalán', 'Garrotero', 'Velador', 'Plomero', 'Chofer de tráiler', 'Mesero', 'Cerillo', 'Franelero', 'Taquero', 'Tortillera', 'Herrero', 'Jornalero', 'Maquilador', 'Repartidor', 'Paletero', 'Bolero', 'Talachero', 'Hojalatero', 'Vulcanizador', 'Ayudante general', 'Montacarguista', 'Soldador de estructura', 'Operador de retroexcavadora', 'Niñera de planta', 'Cocinero de fonda', 'Lavaloza', 'Intendente', 'Checador', 'Promotor de ventas', 'Cobrador'].map((text) => ({
    text,
    kind: 'pos' as const,
    lang: 'es',
  })),
  ...['Solda TIG em inox', 'Leitura de projeto elétrico', 'Operação de munck', 'Pintura epóxi', 'Atendimento ao cliente no balcão'].map((text) => ({ text, kind: 'skill' as const, lang: 'pt' })),
  ...['Soldadura con microalambre', 'Manejo de montacargas', 'Lectura de planos', 'Atención a clientes en mostrador', 'Instalación de tablaroca'].map((text) => ({ text, kind: 'skill' as const, lang: 'es' })),
];

/** Long claims, up to `DRAFT_LIMITS.chars`, as a CV writes a duty or a certificate in full. */
export function longClaims(base: readonly Claim[], r: () => number, n: number): Claim[] {
  const out: Claim[] = [];
  for (let k = 0; out.length < n && k < n * 20; k++) {
    const first = pick(r, base);
    const same = base.filter((c) => c.lang === first.lang && c.kind === first.kind && c !== first);
    let text = first.text;
    while (same.length) {
      const next = `${text}, ${pick(r, same).text.toLowerCase()}`;
      if (next.length > DRAFT_LIMITS.chars) break;
      text = next;
    }
    if (text.length >= 70 && !out.some((c) => c.text === text)) out.push({ text, kind: first.kind, lang: first.lang, origin: 'long' });
  }
  return out;
}

/** About `n` claims: the fixtures', long ones, then misspelt, abbreviated and local ones. */
export function claimSet(fixtures: string, r: () => number, n = 600): Claim[] {
  const base = fixtureClaims(fixtures);
  const out: Claim[] = [...base, ...longClaims(base, r, 40)];
  const seen = new Set(out.map((c) => c.text));
  const add = (c: Claim) => {
    if (seen.has(c.text) || !c.text.trim() || c.text.length > DRAFT_LIMITS.chars) return;
    seen.add(c.text);
    out.push(c);
  };
  for (const c of LOCAL_NAMES) add({ ...c, origin: 'local' });
  for (const c of sample(r, base, base.length)) {
    const a = abbreviate(c.text);
    if (a) add({ ...c, text: a, origin: 'abbreviated' });
  }
  for (const c of sample(r, base, base.length)) {
    if (out.length >= n) break;
    const m = misspell(c.text, r);
    if (m) add({ ...c, text: m, origin: 'misspelt' });
  }
  return out.slice(0, n);
}

// ── 3. Listing texts ───────────────────────────────────────────────────────

const draftOf = (lang: string, titles: string[], skills: string[], certificates: string[]): ListingDraft => ({
  pseudonym: 'embed-phone',
  profileId: 'p1',
  region: lang === 'pt' ? 'br-rj' : lang === 'es' ? 'mx-tam' : 'us-tx',
  scope: 'onsite',
  tier: 1,
  lang: lang === 'pt' || lang === 'es' ? lang : 'en',
  titles,
  skills,
  certificates,
  languages: [],
});

/**
 * `n` listing texts as `listingText` writes them: small drafts first, then
 * larger ones, the last tenth at the most a draft allows (`DRAFT_LIMITS`, each
 * string up to its 120 characters), which runs past the embedder's 1,024
 * tokens; the English names in brackets are English registry labels, one a claim.
 */
export function listingTexts(claims: readonly Claim[], english: { pos: readonly string[]; skill: readonly string[] }, r: () => number, n = 200): { text: string; lang: string }[] {
  const out: { text: string; lang: string }[] = [];
  const langs = ['pt', 'es', 'en'];
  const long = claims.filter((c) => c.text.length >= 70);
  for (let i = 0; i < n; i++) {
    const lang = langs[i % 3]!;
    const mine = claims.filter((c) => c.lang === lang);
    const of = (kind: ClaimKind) => mine.filter((c) => c.kind === kind).map((c) => c.text);
    const max = i >= n - Math.ceil(n / 10);
    const size = max ? 1 : i < n * 0.2 ? 0.05 : i < n * 0.6 ? 0.25 : 0.6;
    const count = (limit: number) => Math.max(0, Math.round(limit * size * (0.5 + r())));
    const fill = (kind: ClaimKind, limit: number) => {
      const pool = of(kind).length ? of(kind) : of('skill');
      if (!max) return sample(r, pool, Math.min(limit, count(limit)));
      // The most a draft allows: every list full, each string near its 120 characters.
      const longPool = long.filter((c) => c.lang === lang).map((c) => c.text);
      return Array.from({ length: limit }, () => {
        let s = pick(r, longPool.length ? longPool : pool);
        while (s.length < DRAFT_LIMITS.chars - 20) s = `${s}; ${pick(r, pool)}`.slice(0, DRAFT_LIMITS.chars);
        return s.slice(0, DRAFT_LIMITS.chars);
      });
    };
    const titles = fill('pos', DRAFT_LIMITS.titles);
    if (!titles.length) titles.push(pick(r, of('pos').length ? of('pos') : of('skill')));
    const skills = fill('skill', DRAFT_LIMITS.skills);
    const certificates = fill('cert', DRAFT_LIMITS.certificates);
    const names = [...titles.map(() => pick(r, english.pos)), ...[...skills, ...certificates].map(() => pick(r, english.skill))];
    out.push({ text: listingText(draftOf(lang, titles, skills, certificates), names), lang });
  }
  return out;
}

// ── 4. Hirer sentences ─────────────────────────────────────────────────────

const PLACES = { en: ['Houston', 'Corpus Christi', 'Baton Rouge', 'Galveston'], pt: ['Macaé', 'Santos', 'Rio das Ostras', 'Vitória'], es: ['Tampico', 'Ciudad del Carmen', 'Coatzacoalcos', 'Monterrey'] };
const OPENERS = {
  en: ['Need a {t}', 'Looking for a {t} with {s}', 'Hiring a {t} who has {s} and {c}', '{t} needed for {d} in {p}'],
  pt: ['Preciso de um {t}', 'Procuro {t} com {s}', 'Contrato {t} com {s} e {c}', 'Vaga de {t} por {d} em {p}'],
  es: ['Necesito un {t}', 'Busco {t} con {s}', 'Contrato {t} con {s} y {c}', 'Se solicita {t} por {d} en {p}'],
};
const FILLERS = {
  en: [
    'The work is on a 14 by 14 rotation with meals and lodging on site.',
    'Start next Monday, pay is weekly and overtime is paid at time and a half.',
    'You will report to the maintenance lead and follow the permit to work system.',
    'Prior offshore experience helps, and a valid passport is required for the crew change.',
    'We provide the safety gear; bring your own hand tools and work boots.',
    'The budget is about $4,500 a month, depending on experience.',
  ],
  pt: [
    'O regime é de 14 por 14 com alimentação e alojamento a bordo.',
    'Início na próxima segunda, pagamento semanal e horas extras com 50%.',
    'A pessoa responde ao encarregado de manutenção e segue a permissão de trabalho.',
    'Experiência offshore conta pontos e é preciso ter passaporte válido para o embarque.',
    'Fornecemos os EPIs; traga suas ferramentas manuais e botina.',
    'O orçamento é de cerca de R$ 6.500 por mês, conforme a experiência.',
  ],
  es: [
    'El trabajo es en rol de 14 por 14 con comida y hospedaje en sitio.',
    'Empieza el próximo lunes, el pago es semanal y las horas extra se pagan dobles.',
    'Reportarás al jefe de mantenimiento y seguirás el permiso de trabajo.',
    'Se valora experiencia costa afuera y se requiere pasaporte vigente para el cambio de guardia.',
    'Damos el equipo de seguridad; trae tu herramienta de mano y botas.',
    'El presupuesto es de unos $45,000 MXN al mes, según la experiencia.',
  ],
};
const DURATIONS = { en: ['three months', 'six weeks', 'one year'], pt: ['três meses', 'seis semanas', 'um ano'], es: ['tres meses', 'seis semanas', 'un año'] };

/** `n` hirer sentences, a third in each language, a few words up to `INTENT_MAX_CHARS`, the fixtures' own first. */
export function sentenceSet(fixtures: string, claims: readonly Claim[], r: () => number, n = 300): { text: string; lang: string }[] {
  const out: { text: string; lang: string }[] = [];
  const floor = JSON.parse(readFileSync(join(fixtures, 'tier2-floor.json'), 'utf8')) as { sentences: { locale: string; text: string }[] };
  const prompts = JSON.parse(readFileSync(join(fixtures, 'hirer-prompts.json'), 'utf8')) as { prompts: { locale: string; text: string }[] };
  for (const s of [...floor.sentences, ...prompts.prompts]) out.push({ text: s.text, lang: s.locale.slice(0, 2) });
  const targets = [12, 30, 60, 100, 160, 250, 400, 600, 800, INTENT_MAX_CHARS];
  for (let i = 0; out.length < n; i++) {
    const lang = (['en', 'pt', 'es'] as const)[i % 3]!;
    const mine = claims.filter((c) => c.lang === lang);
    const of = (kind: ClaimKind) => {
      const pool = mine.filter((c) => c.kind === kind);
      return (pool.length ? pick(r, pool) : pick(r, mine)).text;
    };
    let text = pick(r, OPENERS[lang])
      .replace('{t}', of('pos').toLowerCase())
      .replace('{s}', of('skill').toLowerCase())
      .replace('{c}', of('cert'))
      .replace('{d}', pick(r, DURATIONS[lang]))
      .replace('{p}', pick(r, PLACES[lang]));
    text = `${text}.`;
    const target = targets[i % targets.length]!;
    while (text.length < target) text = `${text} ${pick(r, FILLERS[lang])}`;
    if (text.length > INTENT_MAX_CHARS) text = text.slice(0, INTENT_MAX_CHARS).replace(/\s+\S*$/, '');
    if (!out.some((s) => s.text === text)) out.push({ text, lang });
  }
  return out.slice(0, n);
}

// ── 5. Awkward texts ───────────────────────────────────────────────────────

export interface Awkward {
  text: string;
  role: Role;
  change: string;
  /** The clean form's own text and role (embedded in sets 2 and 4, or beside it); none for a text of its own. */
  clean?: string;
  /** Whether the plane takes both and holds them as one text (`planeClaim`, `planeSentence`; a claim the draft check refuses is none). */
  planeSame?: boolean;
}

/** About a hundred awkward texts from the claims and sentences, each beside its clean form, and the long ones. */
export function awkwardSet(claims: readonly Claim[], sentences: readonly { text: string }[], r: () => number): Awkward[] {
  const out: Awkward[] = [];
  /** A variant of a claim (the plane's claim rules) or of a sentence (its sentence rules), in each role given. */
  const variant = (clean: string, text: string, change: string, roles: readonly Role[], plane: (s: string) => string, takes: (s: string) => boolean) => {
    for (const role of roles) out.push({ text, role, change, clean, planeSame: takes(text) && takes(clean) && plane(text) === plane(clean) });
  };
  const ofClaim = (c: { text: string }, text: string, change: string, roles: readonly Role[] = ['query']) => variant(c.text, text, change, roles, planeClaim, planeTakesClaim);
  const ofSentence = (s: { text: string }, text: string, change: string) => variant(s.text, text, change, ['query'], planeSentence, planeTakesSentence);
  const spaced = claims.filter((c) => c.text.includes(' '));
  const shortSentences = sentences.filter((s) => s.text.length < 300 && s.text.includes(' '));
  for (const c of sample(r, spaced, 10)) ofClaim(c, `  ${c.text.replace(' ', '  \t').replace(/ (?=\S+$)/, '\n')}  `, 'white space', ['query', 'document']);
  for (const s of sample(r, shortSentences, 5)) ofSentence(s, `\n ${s.text.replace(' ', '   ')} \t`, 'white space');
  for (const c of sample(r, claims.filter((c) => c.text.normalize('NFD') !== c.text), 15)) ofClaim(c, c.text.normalize('NFD'), 'decomposed accents (NFD)', ['query', 'document']);
  for (const s of sample(r, sentences.filter((s) => s.text.normalize('NFD') !== s.text), 5)) ofSentence(s, s.text.normalize('NFD'), 'decomposed accents (NFD)');
  for (const c of sample(r, claims.filter((c) => c.text.includes('fi')), 3)) ofClaim(c, c.text.replace(/fi/g, '\ufb01'), 'ligature (ﬁ)');
  for (const s of sample(r, sentences.filter((s) => s.text.includes('fi')), 2)) ofSentence(s, s.text.replace(/fi/g, '\ufb01'), 'ligature (ﬁ)');
  for (const c of sample(r, spaced, 5)) ofClaim(c, c.text.replace(/ /g, '\u00a0'), 'no-break spaces');
  for (const s of sample(r, shortSentences, 3)) ofSentence(s, s.text.replace(/ /g, '\u00a0'), 'no-break spaces');
  const curly = (t: string) => {
    let open = true;
    return t
      .replace(/'/g, '\u2019')
      .replace(/"/g, () => {
        open = !open;
        return open ? '\u201d' : '\u201c';
      })
      .replace(/ - /g, ' \u2013 ')
      .replace(/-/g, '\u2011');
  };
  for (const c of sample(r, claims.filter((c) => /['"-]/.test(c.text)), 3)) ofClaim(c, curly(c.text), 'curly quotes and dashes');
  for (const s of sample(r, sentences.filter((s) => /['"-]/.test(s.text)), 2)) ofSentence(s, curly(s.text), 'curly quotes and dashes');
  for (const c of sample(r, claims, 5)) ofClaim(c, `${c.text} ${pick(r, ['👷', '🔧', '⚡', '🛢️', '✅'])}`, 'emoji');
  for (const c of sample(r, claims, 5)) ofClaim(c, c.text.toUpperCase(), 'capitals');
  for (const text of ['Válido até 15/03/2027', 'NR-10 (40 h) – 2024', '5+ years, US$ 4,500/month', 'Turno 14x14 offshore, 2.º semestre', 'CNH categoria D, 12 anos de estrada']) {
    out.push({ text, role: 'query', change: 'dates and numbers' });
  }
  // Past the embedder's 1,024 tokens, and lengths around it (about 4.7 characters a token in English).
  const filler = FILLERS.en.join(' ');
  for (const chars of [3_000, 4_000, 4_500, 5_000, 6_000]) {
    let text = filler;
    while (text.length < chars) text = `${text} ${filler}`;
    out.push({ text: text.slice(0, chars), role: 'document', change: `long, ${chars} characters` });
  }
  return out;
}

// ── The plan ───────────────────────────────────────────────────────────────

/**
 * The whole plan: the texts with ids by set (`L`, `C…q`/`C…d`, `J`, `S`, `A`),
 * every text over `LONG_TEXT_CHARS` moved to the end, their meta for the
 * scorer, and a listing of 20 claims to time (its 20 queries in one call, its 20
 * claim documents and the listing text in another).
 */
export function buildPlan(opts: {
  fixtures: string;
  rows: readonly ReplicaRow[];
  regions: Readonly<Record<string, string>>;
  seed?: number;
}): EmbedPhonePlan {
  const r = seeded(opts.seed ?? 20261030);
  const texts: PlanText[] = [];
  const meta: TextMeta[] = [];
  const add = (t: PlanText, m: Omit<TextMeta, 'id' | 'role' | 'chars'>) => {
    texts.push(t);
    meta.push({ id: t.id, role: t.role, chars: t.text.length, ...m });
  };
  sampleLabels(opts.rows, opts.regions, r).forEach((l, i) => {
    add({ id: `L${i}`, text: opts.rows[l.row]!.label, role: 'document' }, { set: 'label', kind: l.kind, lang: l.lang, row: l.row });
  });
  const claims = claimSet(opts.fixtures, r);
  claims.forEach((c, i) => {
    add({ id: `C${i}q`, text: c.text, role: 'query' }, { set: 'claim', kind: c.kind, lang: c.lang });
    add({ id: `C${i}d`, text: c.text, role: 'document' }, { set: 'claim', kind: c.kind, lang: c.lang });
  });
  const english = {
    pos: opts.rows.filter((x) => x.kind === 'pos' && x.lang === 'en').map((x) => x.label),
    skill: opts.rows.filter((x) => x.kind === 'skill' && x.lang === 'en').map((x) => x.label),
  };
  listingTexts(claims, english, r).forEach((l, i) => add({ id: `J${i}`, text: l.text, role: 'document' }, { set: 'listing', lang: l.lang }));
  const sentences = sentenceSet(opts.fixtures, claims, r);
  sentences.forEach((s, i) => add({ id: `S${i}`, text: s.text, role: 'query' }, { set: 'sentence', lang: s.lang }));
  // An awkward text's clean form is a text already in the plan when its role matches; else it is added beside it.
  const byText = new Map(texts.map((t) => [`${t.role}\u0000${t.text}`, t.id]));
  awkwardSet(claims, sentences, r).forEach((a, i) => {
    let cleanId: string | undefined;
    if (a.clean != null) {
      cleanId = byText.get(`${a.role}\u0000${a.clean}`);
      if (!cleanId) {
        cleanId = `A${i}c`;
        add({ id: cleanId, text: a.clean, role: a.role }, { set: 'awkward', change: 'clean form' });
        byText.set(`${a.role}\u0000${a.clean}`, cleanId);
      }
    }
    add({ id: `A${i}`, text: a.text, role: a.role }, { set: 'awkward', change: a.change, ...(cleanId ? { cleanId } : {}), ...(a.planeSame != null ? { planeSame: a.planeSame } : {}) });
  });
  // The listing to time: 20 claims of one CV's worth, as the app sends a listing, within the draft's limits.
  const pt = claims.filter((c) => c.lang === 'pt');
  const titles = pt.filter((c) => c.kind === 'pos').slice(0, DRAFT_LIMITS.titles);
  const twenty = [...titles, ...pt.filter((c) => c.kind !== 'pos').slice(0, 20 - titles.length)];
  const draft = draftOf('pt', titles.map((c) => c.text), twenty.filter((c) => c.kind === 'skill').map((c) => c.text), twenty.filter((c) => c.kind === 'cert').map((c) => c.text));
  const listing = {
    queries: twenty.map((c) => c.text),
    documents: [...twenty.map((c) => c.text), listingText(draft, twenty.map((c) => (c.kind === 'pos' ? pick(r, english.pos) : pick(r, english.skill))))],
    runs: 3,
  };
  // The long texts last, each set's order kept: a run the system ends on one of them has embedded the rest.
  const order = texts.map((t, i) => i).sort((i, j) => Number(texts[i]!.text.length > LONG_TEXT_CHARS) - Number(texts[j]!.text.length > LONG_TEXT_CHARS) || i - j);
  return {
    plan: { v: 1, source: 'cofferdam-api test/workEmbedPhone.eval.test.ts', runs: 1, cvs: [], readers: [], embed: { texts: order.map((i) => texts[i]!), listing } },
    meta: order.map((i) => meta[i]!),
  };
}

/** The plan's texts as one digest, whatever their order: the Mac's cached vectors belong to exactly these. */
export function planDigest(texts: readonly PlanText[]): string {
  const sorted = [...texts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(sorted.map((t) => [t.id, t.role, t.text]))).digest('hex');
}

// ── Scoring ────────────────────────────────────────────────────────────────

/** A phone's vector: base64 float32, little-endian. */
export function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const out = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** The cosine of two vectors; NaN when their lengths differ or either is zero or not finite (a vector the plane refuses). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
}

/**
 * The smallest, the 0.1th percentile and the median, and how many fall below `bar`. A value that is not a number
 * (a broken vector's cosine) counts below the bar and makes the smallest NaN.
 */
export function spread(values: readonly number[], bar: number): { n: number; min: number; p001: number; median: number; below: number } {
  const s = values.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  const broken = values.length - s.length;
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  return { n: values.length, min: broken ? NaN : (s[0] ?? NaN), p001: broken ? NaN : at(0.001), median: at(0.5), below: broken + s.filter((v) => v < bar).length };
}

/**
 * A snap's outcome on the replica, as the plane reads the nearest labels (`registry.ts` `candidatesFor`): each
 * token's best score among them, the best token, its best score through a label in the string's own language or
 * English (`scoped`, which τ_auto reads), and the tokens Clef would be shown in the band.
 */
export interface Snap {
  token: string;
  score: number;
  scoped: number | null;
  scores: ReadonlyMap<string, number>;
  candidates: readonly string[];
}

export function snapOf(matches: readonly { score: number; metadata?: Readonly<Record<string, unknown>> }[], langs?: readonly string[]): Snap | null {
  const best = new Map<string, number>();
  const scoped = new Map<string, number>();
  for (const m of matches) {
    const t = String(m.metadata?.token ?? '');
    if (!best.has(t) || m.score > best.get(t)!) best.set(t, m.score);
    const lang = m.metadata?.lang;
    if (langs && typeof lang === 'string' && langs.includes(lang) && m.score > (scoped.get(t) ?? -Infinity)) scoped.set(t, m.score);
  }
  const ranked = [...best].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [token, score] = ranked[0]!;
  return { token, score, scoped: scoped.get(token) ?? null, scores: best, candidates: ranked.slice(0, ADJUDICATION_CANDIDATES).map(([t]) => t) };
}

/** τ_auto and τ_low, the two thresholds a snap reads (the tier-2 floor is recall's, on a listing's cosine: `sameTop`). */
export interface Thresholds {
  auto: number;
  low: number;
}

/** What the plane does with a snap's nearest labels: take the best token (τ_auto, on `scoped`), ask Clef (τ_low), or neither. */
export function stepOf(s: Snap, t: Thresholds): 'auto' | 'band' | 'below' {
  return s.scoped != null && s.scoped >= t.auto ? 'auto' : s.score >= t.low ? 'band' : 'below';
}

/**
 * Whether two snaps of one string decide alike, as the plane reads them at each step: the same step, a different
 * one passing only when both scores sit within `eps` of the threshold between them (τ_auto on `scoped`, τ_low on the
 * best score); taken at τ_auto, the same token; in the band, the same token and the same candidates for Clef
 * (`sameCandidates`); under τ_low, nothing the vector chose (step 3 reads the string and its English name). A
 * different token passes only on a tie, each side's token within `eps` of the other's.
 */
export function sameDecision(a: Snap, b: Snap, t: Thresholds, eps = 0.001): { ok: boolean; flip: 'side' | 'token' | 'candidates' | null; passed: boolean } {
  const near = (x: number | null, y: number | null, at: number) => x != null && y != null && Math.abs(x - at) <= eps && Math.abs(y - at) <= eps;
  const sa = stepOf(a, t);
  const sb = stepOf(b, t);
  if (sa !== sb) {
    let ok = true;
    if ((sa === 'auto') !== (sb === 'auto')) ok &&= near(a.scoped, b.scoped, t.auto);
    if ((sa === 'below') !== (sb === 'below')) ok &&= near(a.score, b.score, t.low);
    return { ok, flip: 'side', passed: ok };
  }
  if (sa === 'below') return { ok: true, flip: null, passed: false };
  if (a.token !== b.token) {
    const tie = (s: Snap, other: string) => s.score - (s.scores.get(other) ?? -Infinity) <= eps;
    if (!tie(a, b.token) || !tie(b, a.token)) return { ok: false, flip: 'token', passed: false };
  }
  if (sa === 'band') {
    const c = sameCandidates(a, b, eps);
    if (!c.same) return { ok: c.atEdge, flip: a.token !== b.token ? 'token' : 'candidates', passed: c.atEdge };
  }
  return a.token !== b.token ? { ok: true, flip: 'token', passed: true } : { ok: true, flip: null, passed: false };
}

/**
 * Whether Clef would be shown the same candidates in the band: the same tokens, or tokens that differ only where
 * the list's last place is a tie within `eps` on both sides.
 */
export function sameCandidates(a: Snap, b: Snap, eps = 0.001): { same: boolean; atEdge: boolean } {
  const inA = new Set(a.candidates);
  const inB = new Set(b.candidates);
  const onlyA = a.candidates.filter((x) => !inB.has(x));
  const onlyB = b.candidates.filter((x) => !inA.has(x));
  if (!onlyA.length && !onlyB.length) return { same: true, atEdge: false };
  const last = (s: Snap) => s.scores.get(s.candidates[s.candidates.length - 1]!) ?? -Infinity;
  const edge = (s: Snap, other: Snap, tokens: readonly string[]) => tokens.every((x) => Math.abs((s.scores.get(x) ?? -Infinity) - last(s)) <= eps && last(other) - (other.scores.get(x) ?? -Infinity) <= eps);
  return { same: false, atEdge: edge(a, b, onlyA) && edge(b, a, onlyB) };
}

/** The `k` nearest documents to a query, by cosine, best first. */
export function nearest(q: ArrayLike<number>, docs: readonly { id: string; v: ArrayLike<number> }[], k: number): { id: string; score: number }[] {
  return docs
    .map((d) => ({ id: d.id, score: cosine(q, d.v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Whether two top-`k` lists hold the same documents, and above the floor the
 * same ones: a document in one list and not the other passes only when its
 * score sits within `eps` of the list's `k`th, and one on a different side of
 * the floor only when both scores are within `eps` of it.
 */
export function sameTop(a: readonly { id: string; score: number }[], b: readonly { id: string; score: number }[], floor: number, eps = 0.001): { ok: boolean; flips: number; passed: number } {
  let flips = 0;
  let passed = 0;
  const kthA = a[a.length - 1]?.score ?? -1;
  const kthB = b[b.length - 1]?.score ?? -1;
  const inB = new Map(b.map((x) => [x.id, x.score]));
  const inA = new Map(a.map((x) => [x.id, x.score]));
  for (const x of a) {
    if (!inB.has(x.id)) {
      flips++;
      if (Math.abs(x.score - kthA) <= eps && Math.abs(x.score - kthB) <= eps * 2) passed++;
    } else if (x.score >= floor !== inB.get(x.id)! >= floor) {
      flips++;
      if (Math.abs(x.score - floor) <= eps && Math.abs(inB.get(x.id)! - floor) <= eps) passed++;
    }
  }
  for (const y of b) {
    if (!inA.has(y.id)) {
      flips++;
      if (Math.abs(y.score - kthB) <= eps && Math.abs(y.score - kthA) <= eps * 2) passed++;
    }
  }
  return { ok: flips === passed, flips, passed };
}
