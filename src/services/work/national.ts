// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * National alias layers over the ESCO spine (workspace decision 0066). A
 * market's own occupation classification (O*NET in the US, then Brazil's CBO
 * and Mexico's SINCO) adds labels and codes to ESCO's tokens, never a second
 * token space.
 *
 * - **Labels.** A layer's label is an alternative label of its token. It is
 *   tagged with its region (`us`, `br`, `mx`) and its source: the layer, its
 *   release and the national code (`onet:31.0:47-2152.00`). That lets it be
 *   re-imported, removed, or ranked by the user's region.
 * - **Codes.** A token keeps its national codes, with how the crosswalk matched
 *   them.
 *
 * Codes come only from the official files. `onet.ts` builds the US layer.
 *
 * The SQL needs `migrations/work/0003_national_layers.sql`. Like the ESCO
 * import's, it is cut into files of `SQL_STATEMENTS_PER_FILE` statements, the
 * labels before the codes, and a second load inserts nothing twice.
 */

import { SQL_STATEMENTS_PER_FILE, sqlValue } from './esco.js';
import type { RegistryLabel, RegistryToken } from './registry.js';

/** How a crosswalk matched a token: broad means the national occupation is wider than the token, narrow that it is narrower. */
export const CODE_RELATIONS = ['exact', 'close', 'broad', 'narrow', 'isco'] as const;
export type CodeRelation = (typeof CODE_RELATIONS)[number];

/** A region's alternative label of an ESCO token. */
export interface NationalLabel extends RegistryLabel {
  /** The layer, its release and the national code: `onet:31.0:47-2152.00`. */
  source: string;
  /** Whose words these are: `us`, `br`, `mx`. */
  region: string;
}

/** A token's code in a national classification. */
export interface NationalCode {
  token: string;
  /** The classification and its version: `onet-soc-2019`. */
  scheme: string;
  code: string;
  relation: CodeRelation;
  /** The crosswalk or correspondence the pair comes from: `esco-onet-crosswalk-v1`. */
  source: string;
}

/** Rows per INSERT, as in the ESCO import. */
const ROWS = 100;
/** Vector metadata keeps 64 indexed bytes per string and 10 KiB in all; a label is cut to this, as `vectorLine` cuts ESCO's. */
const LABEL_META_MAX = 200;

function statements(labels: readonly NationalLabel[], codes: readonly NationalCode[], at: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < labels.length; i += ROWS) {
    const rows = labels
      .slice(i, i + ROWS)
      .map((l) => `(${[l.labelId, l.embedded ? 1 : 0, l.token, l.lang, l.label, l.labelNorm, l.kind, l.source, l.region, at].map(sqlValue).join(', ')})`);
    out.push(
      `INSERT INTO registry_labels (label_id, embedded, token, lang, label, label_norm, kind, source, region, created_at) VALUES\n${rows.join(',\n')}\nON CONFLICT DO NOTHING;`,
    );
  }
  for (let i = 0; i < codes.length; i += ROWS) {
    const rows = codes.slice(i, i + ROWS).map((c) => `(${[c.token, c.scheme, c.code, c.relation, c.source, at].map(sqlValue).join(', ')})`);
    out.push(`INSERT INTO registry_codes (token, scheme, code, relation, source, created_at) VALUES\n${rows.join(',\n')}\nON CONFLICT DO NOTHING;`);
  }
  return out;
}

/**
 * A layer as SQL files for `wrangler d1 execute cofferdam-work --remote --file=…`,
 * each at most `per` statements, cut only between statements and in order. The
 * tokens must exist already: a layer only adds to them.
 */
export function nationalSqlFiles(labels: readonly NationalLabel[], codes: readonly NationalCode[], at: number, per = SQL_STATEMENTS_PER_FILE): string[] {
  const all = statements(labels, codes, at);
  const files: string[] = [];
  for (let i = 0; i < all.length; i += per) files.push(all.slice(i, i + per).join('\n') + '\n');
  return files;
}

/** One NDJSON line per national label's vector: ESCO's metadata plus the region and the layer. */
export function nationalVectorLine(label: NationalLabel, token: RegistryToken, values: number[]): string {
  const metadata: Record<string, string> = {
    token: label.token,
    kind: token.kind,
    lang: label.lang,
    label: label.label.slice(0, LABEL_META_MAX),
    source: token.source,
    region: label.region,
    layer: label.source.split(':')[0] ?? label.source,
    ...(token.iscoCode ? { isco: token.iscoCode } : {}),
  };
  return JSON.stringify({ id: label.labelId, values: values.map((v) => Math.round(v * 1e6) / 1e6), metadata });
}
