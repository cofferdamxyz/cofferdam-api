// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import type { AiBinding } from '../src/services/inference/index.js';
import { clefInput, documentQuestions } from '../src/services/work/clef.js';
import { callCost } from './chat-eval/score.js';
import type { RecordedCall } from './chat-eval/restAi.js';
import { localClefModel, localClefSlug, parseLocalClef, withLocalClef } from './work-eval/localClef.js';

const clef = { label: 'd1-2B Q4_K_M (llama.cpp)', url: 'http://127.0.0.1:8090' };

describe('a local decision model in Clef\'s place (evaluations only)', () => {
  it('reads its variable and refuses what it cannot use', () => {
    expect(parseLocalClef(undefined, 'X')).toBeNull();
    expect(parseLocalClef(' ', 'X')).toBeNull();
    expect(parseLocalClef('{"label":" d1 ","url":"http://127.0.0.1:8090/v1/systemone"}', 'X')).toEqual({ label: 'd1', url: 'http://127.0.0.1:8090' });
    expect(() => parseLocalClef('[1]', 'X')).toThrow(/X.label/);
    expect(() => parseLocalClef('{"label":"d1","url":"127.0.0.1:8090"}', 'X')).toThrow(/X.url/);
    expect(() => parseLocalClef('not json', 'X')).toThrow(/JSON object/);
    expect(localClefModel(clef)).toBe('local:d1-2B Q4_K_M (llama.cpp)');
    expect(localClefSlug(clef)).toBe('d1-2b-q4-k-m-llama-cpp');
  });

  it('answers Clef models locally, passes the rest through and records each local call at no cost', async () => {
    const posted: { url: string; body: any }[] = [];
    const answer = { answers: { document: { choice: 'cv', confidence: 0.93, probabilities: { cv: 0.93, other: 0.07 } } }, usage: { input_tokens: 120, output_tokens: 0 } };
    const fakeFetch = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;
    const passed: string[] = [];
    const inner = { run: async (model: string) => (passed.push(model), { data: [[0.1]] }) } as unknown as AiBinding;
    const calls: RecordedCall[] = [];
    const ai = withLocalClef(inner, clef, { fetch: fakeFetch, onCall: (c) => calls.push(c) }) as unknown as { run: (m: string, i: Record<string, unknown>) => Promise<unknown> };

    const input = clefInput('@cf/cloudflare/clef-flash', '[summary]\nPlumber.', documentQuestions());
    expect(await ai.run('@cf/cloudflare/clef-flash', input)).toEqual(answer);
    await ai.run('@cf/cloudflare/clef', clefInput('@cf/cloudflare/clef', 'x', documentQuestions()));
    await ai.run('@cf/google/embeddinggemma-300m', { text: ['x'] });

    expect(posted.map((p) => p.url)).toEqual(['http://127.0.0.1:8090/v1/systemone', 'http://127.0.0.1:8090/v1/systemone']);
    // Clef's body names its model; the local server gets the state and the questions only.
    expect(posted[0]!.body).toEqual({ state: '[summary]\nPlumber.', questions: documentQuestions() });
    expect(passed).toEqual(['@cf/google/embeddinggemma-300m']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: 'local:d1-2B Q4_K_M (llama.cpp)', status: 200, usage: { prompt_tokens: 120, completion_tokens: 0 }, result: answer });
    expect(callCost(calls[0]!)).toMatchObject({ tokensIn: 120, tokensOut: 0, estimated: false, usd: 0 });
  });

  it('names the local model when it fails', async () => {
    const refuse = (async () => new Response('{"error":"bad question"}', { status: 400 })) as unknown as typeof fetch;
    const ai = withLocalClef({ run: async () => null } as unknown as AiBinding, clef, { fetch: refuse }) as unknown as { run: (m: string, i: Record<string, unknown>) => Promise<unknown> };
    await expect(ai.run('@cf/cloudflare/clef-flash', { model: 'clef-flash', state: 'x', questions: {} })).rejects.toThrow(/d1-2B Q4_K_M \(llama.cpp\) answered 400/);
  });
});
