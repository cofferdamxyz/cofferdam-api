// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A JSON schema as one regex for LiteRT-LM's constrained decoding (workspace
 * decision 0068, the regex constraint of 2026-10-29).
 *
 * LiteRT-LM hands llguidance the tokenizer's raw SentencePiece pieces
 * (google-ai-edge/LiteRT-LM#3510), where a space is U+2581 and no token holds
 * byte 0x20. Under a JSON-schema constraint Gemma 4 E2B can then never write
 * the space it puts after a colon, and it answers `null` wherever the schema
 * allows one. This regex spells the same JSON with whitespace that also takes
 * U+2581, so the model writes its own spaces, which the detokenizer turns back
 * into 0x20: the answer is valid JSON as written. Strings refuse `<`, so a
 * byte piece (`<0x0A>`, which the table also spells raw) never lands in one.
 *
 * The parse schema's subset only: objects with every property required and no
 * others (written in the schema's order), arrays with `maxItems`, strings,
 * booleans, integers with no bounds or a range from 0 of at most 200 values
 * (written out), string enums, and unions of those with null. Any other type,
 * keyword or range throws, so the regex never admits what the schema refuses.
 *
 * A workaround, to revert once LiteRT-LM's JSON-schema constraint lets Gemma 4
 * E2B write its spaces (#3510, and #3721): workspace decision 0068's entry "The
 * JSON workaround for LiteRT-LM" lists every place that uses it and the check
 * to run first.
 */

/** Whitespace between tokens: JSON's own, plus SentencePiece's U+2581. */
export const REGEX_WS = '[ \\t\\n\\r▁]*';

/** A JSON string without `<`: any other character but a quote, a backslash or a control character, or an escape. */
export const REGEX_STRING = String.raw`"(?:[^"\\\x00-\x1f<]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: unknown;
  items?: Schema;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
};

/** The keywords each type may carry; `description` and `title` change nothing a regex checks. */
const KEYWORDS: Record<string, string[]> = {
  null: [],
  boolean: [],
  string: ['enum'],
  integer: ['minimum', 'maximum'],
  array: ['items', 'maxItems'],
  object: ['properties', 'required', 'additionalProperties'],
};

/** Refuses a keyword none of the schema's types can carry here (a `pattern`, a `minItems`, a `format`, …). */
function checkKeywords(s: Schema): void {
  const types = Array.isArray(s.type) ? s.type : [s.type ?? (s.enum ? 'string' : '')];
  const allowed = new Set(['type', 'description', 'title', ...types.flatMap((t) => KEYWORDS[t] ?? [])]);
  const unknown = Object.keys(s).filter((k) => !allowed.has(k));
  if (unknown.length) throw new Error(`schemaRegex: unsupported keyword ${unknown.join(', ')} for ${JSON.stringify(s.type)}`);
}

function integer(s: Schema): string {
  const { minimum: lo, maximum: hi } = s;
  if (lo == null && hi == null) return '-?(?:0|[1-9][0-9]*)';
  if (Number.isInteger(lo) && Number.isInteger(hi) && (lo as number) >= 0 && (hi as number) >= (lo as number) && (hi as number) - (lo as number) <= 200) {
    const values: string[] = [];
    for (let v = hi as number; v >= (lo as number); v--) values.push(String(v));
    return `(?:${values.join('|')})`;
  }
  throw new Error(`schemaRegex: an integer range it cannot spell (${JSON.stringify(lo)} to ${JSON.stringify(hi)})`);
}

function rx(s: Schema): string {
  checkKeywords(s);
  if (s.enum) {
    if (!s.enum.every((v) => typeof v === 'string')) throw new Error('schemaRegex: only string enums');
    return `(?:${s.enum.map((v) => escape(JSON.stringify(v))).join('|')})`;
  }
  if (Array.isArray(s.type)) return `(?:${s.type.map((t) => one(s, t)).join('|')})`;
  return one(s, s.type);
}

function one(s: Schema, type: string | undefined): string {
  switch (type) {
    case 'null':
      return 'null';
    case 'boolean':
      return '(?:true|false)';
    case 'string':
      return REGEX_STRING;
    case 'integer':
      return integer(s);
    case 'array': {
      if (!s.items) throw new Error('schemaRegex: an array needs items');
      if (s.maxItems === 0) return `\\[${REGEX_WS}\\]`;
      if (s.maxItems != null && (!Number.isInteger(s.maxItems) || s.maxItems < 0)) throw new Error('schemaRegex: maxItems must be a whole number');
      const item = rx(s.items);
      const more = s.maxItems != null ? `{0,${s.maxItems - 1}}` : '*';
      return `\\[${REGEX_WS}(?:${item}(?:${REGEX_WS},${REGEX_WS}${item})${more})?${REGEX_WS}\\]`;
    }
    case 'object': {
      const props = Object.entries(s.properties ?? {});
      const required = new Set(s.required ?? []);
      if (s.additionalProperties !== false || props.length !== required.size || props.some(([k]) => !required.has(k))) {
        throw new Error('schemaRegex: an object must require every property and allow no others');
      }
      const parts = props.map(([k, v]) => `${escape(JSON.stringify(k))}${REGEX_WS}:${REGEX_WS}${rx(v)}`);
      return `\\{${REGEX_WS}${parts.join(`${REGEX_WS},${REGEX_WS}`)}${REGEX_WS}\\}`;
    }
    case undefined:
    default:
      throw new Error(`schemaRegex: unsupported type ${JSON.stringify(type)}`);
  }
}

/** The schema as one regex for the whole answer, whitespace allowed around it. */
export function schemaRegex(schema: unknown): string {
  if (!schema || typeof schema !== 'object') throw new Error('schemaRegex: a schema object is needed');
  return `${REGEX_WS}${rx(schema as Schema)}${REGEX_WS}`;
}

/**
 * The request with its JSON-schema `response_format` replaced by
 * `{type: "regex", pattern}`, which `scripts/work/litert-answers.py` decodes
 * under llguidance. A request without a JSON schema is returned as it is.
 */
export function withSchemaAsRegex(request: Record<string, unknown>): Record<string, unknown> {
  const format = request.response_format as { type?: unknown; json_schema?: unknown } | undefined;
  if (format?.type !== 'json_schema' || !format.json_schema || typeof format.json_schema !== 'object') return request;
  const js = format.json_schema as { schema?: unknown };
  return { ...request, response_format: { type: 'regex', pattern: schemaRegex(js.schema ?? js) } };
}
