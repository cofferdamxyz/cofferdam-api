// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The tools the opt-in registry scripts share on the Mac
 * (`test/fixtures/work/registryTools.ts`): the label vectors cached per model
 * and prompt, read by text; the export of the plane's minted labels; and the
 * names the EmbeddingGemma 2 script shares with the plane.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLIENT_EMBED_MODELS, EMBED_DIMS_BY_MODEL, EMBED_PROMPTS_BY_MODEL, EMBEDDINGGEMMA_2_GGUF, EMBEDDINGGEMMA_2_LITERT } from '../src/services/work/registry.js';
import { cacheStem, exportedLabelLine, ggufOf, litertOf, readLabelExport, readVectorCache, writeVectorCache } from './fixtures/work/registryTools.js';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'registry-tools-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the vector cache', () => {
  it('names the model, its document prompt and the kind, so a changed prompt is a new cache', () => {
    expect(cacheStem('@cf/baai/bge-m3', 'pos')).toBe('bge-m3-pos');
    expect(cacheStem('@cf/google/embeddinggemma-300m', 'skill')).toMatch(/^embeddinggemma-300m-doc-[0-9a-f]{8}-skill$/);
    // The script's names (scripts/work/embed-registry.mjs): no colon or slash in a file name.
    expect(cacheStem(EMBEDDINGGEMMA_2_GGUF, 'pos')).toBe('embeddinggemma-2-GGUF-Q8_0-doc-34669e56-pos');
    expect(cacheStem(EMBEDDINGGEMMA_2_LITERT, 'skill')).toBe('embeddinggemma-2-text-270m-litert-lm-embeddinggemma-2-text-270m.litertlm-doc-34669e56-skill');
  });

  it('reads a vector only for the text it was made from, and no vector for a text the model refused', () => {
    const dir = scratch();
    const v = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.8, 0, 0]);
    writeVectorCache(dir, '@cf/baai/bge-m3', 'pos', ['plumber', 'refused text', 'welder'], v);
    const cached = readVectorCache(dir, '@cf/baai/bge-m3', 'pos', 4)!;
    expect([...cached.keys()]).toEqual(['plumber', 'welder']);
    expect(Array.from(cached.get('welder')!)).toEqual([Math.fround(0.6), Math.fround(0.8), 0, 0]);
    // Another model, or the same one under another prompt, finds no cache.
    expect(readVectorCache(dir, '@cf/google/embeddinggemma-300m', 'pos', 4)).toBeNull();
    // A file that does not hold one vector per text stops the run.
    expect(() => readVectorCache(dir, '@cf/baai/bge-m3', 'pos', 3)).toThrow(/not 3 vectors of 3/);
  });
});

describe('the export of minted labels', () => {
  const answer = (results: unknown[]) => `\n ⛅️ wrangler\n${JSON.stringify([{ results, success: true, meta: { changes: 0 } }])}\n`;
  const row = { label_id: 'l1', token: 'pos:pastry-chef', lang: 'en', label: 'pastry chef', kind: 'pos', source: 'emergent', isco_code: null };

  it("reads wrangler's answer past anything printed before it", () => {
    expect(readLabelExport(answer([row]))).toEqual([row]);
    expect(readLabelExport(answer([]))).toEqual([]);
  });

  it('stops on anything but the answer of one statement with whole rows', () => {
    expect(() => readLabelExport('no json')).toThrow(/no JSON array/);
    expect(() => readLabelExport(JSON.stringify([{ results: [], success: true }, { results: [], success: true }]))).toThrow(/one statement/);
    expect(() => readLabelExport(JSON.stringify([{ results: [], success: false }]))).toThrow(/one statement/);
    expect(() => readLabelExport(answer([{ ...row, label: '' }]))).toThrow(/row 0 has no label/);
    expect(() => readLabelExport(answer([{ ...row, kind: 'job' }]))).toThrow(/kind job/);
  });

  it("writes a minted label's line in the import's shape", () => {
    const line = JSON.parse(exportedLabelLine({ ...row, kind: 'pos', source: 'emergent' }, [0.6, 0.8])) as { id: string; values: number[]; metadata: Record<string, string> };
    expect(line).toEqual({ id: 'l1', values: [0.6, 0.8], metadata: { token: 'pos:pastry-chef', kind: 'pos', lang: 'en', label: 'pastry chef', source: 'emergent' } });
  });
});

describe('EmbeddingGemma 2 on the Mac', () => {
  it("reads the GGUF from the plane's model id, and the script prefixes the plane's document prompt", () => {
    expect(ggufOf(EMBEDDINGGEMMA_2_GGUF)).toBe('ggml-org/embeddinggemma-2-GGUF:Q8_0');
    expect(ggufOf('@cf/google/embeddinggemma-300m')).toBeNull();
    const script = readFileSync(join(__dirname, '..', 'scripts', 'work', 'embed-registry.mjs'), 'utf8');
    expect(script.match(/const DOCUMENT = '([^']*)';/)?.[1]).toBe(EMBED_PROMPTS_BY_MODEL[EMBEDDINGGEMMA_2_GGUF]!.document);
    expect(script).toContain("option('hf', 'ggml-org/embeddinggemma-2-GGUF:Q8_0')");
    // The script names the τ cache as cacheStem does, for either artefact.
    expect(script).toContain(`const GGUF_MODEL = '${EMBEDDINGGEMMA_2_GGUF}';`);
    expect(script).toContain(`const LITERT_MODEL = '${EMBEDDINGGEMMA_2_LITERT}';`);
    expect(script).toContain("MODEL_ID.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-')");
  });

  it("reads the LiteRT-LM file from the v2 generation's model id, which the plane cannot run, at 768 values with the same prompts", () => {
    expect(litertOf(EMBEDDINGGEMMA_2_LITERT)).toBe('embeddinggemma-2-text-270m.litertlm');
    expect(litertOf(EMBEDDINGGEMMA_2_GGUF)).toBeNull();
    expect(litertOf('litertlm:a/b:c.gguf')).toBeNull();
    expect(CLIENT_EMBED_MODELS.has(EMBEDDINGGEMMA_2_LITERT)).toBe(true);
    expect(EMBED_DIMS_BY_MODEL[EMBEDDINGGEMMA_2_LITERT]).toBe(768);
    expect(EMBED_PROMPTS_BY_MODEL[EMBEDDINGGEMMA_2_LITERT]).toEqual(EMBED_PROMPTS_BY_MODEL[EMBEDDINGGEMMA_2_GGUF]);
    for (const script of ['tier2-floor.mjs', 'embed-registry.mjs']) {
      expect(readFileSync(join(__dirname, '..', 'scripts', 'work', script), 'utf8')).toContain(`const LITERT_MODEL = '${EMBEDDINGGEMMA_2_LITERT}';`);
    }
  });
});
