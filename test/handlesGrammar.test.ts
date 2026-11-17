// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { handleIdOf, isStoredHandle, readHandle } from '../src/services/handles/grammar.js';
import vectors from './fixtures/handles/handle-ids.json';

describe('the handle grammar (decision 0086 rule 2, decision 0029 (1))', () => {
  it('accepts the stored form: a-z, 0-9 and -, 3 to 64, no hyphen at either end', () => {
    for (const ok of ['ana', 'a1b', 'maria-silva', 'x-y-z', '123', 'a'.repeat(64)]) expect(isStoredHandle(ok)).toBe(true);
    for (const bad of ['', 'an', 'a'.repeat(65), '-ana', 'ana-', 'ana_b', 'Ana', 'ana.b', 'añа', 'xn--abc', 'ab--c', ' ana', 'ana ', 42, null])
      expect(isStoredHandle(bad)).toBe(false);
    // ENSIP-15 refuses `--` in places three and four only.
    expect(isStoredHandle('a--b')).toBe(true);
    expect(isStoredHandle('ab-c--d')).toBe(true);
  });

  it('reads what a caller typed: a leading @ dropped, ASCII upper case folded, nothing else normalised', () => {
    expect(readHandle('@Ana')).toBe('ana');
    expect(readHandle('MARIA-SILVA')).toBe('maria-silva');
    expect(readHandle('@@ana')).toBeNull();
    // Full-width or accented letters are the phone's to normalise (ENSIP-15) before it asks.
    expect(readHandle('ａｎａ')).toBeNull();
    expect(readHandle('josé')).toBeNull();
    expect(readHandle('ana%20')).toBeNull();
    expect(readHandle(undefined)).toBeNull();
  });

  it('derives handleId as keccak256("cofferdam-handle-v1:" || label), against vectors computed apart from viem', () => {
    for (const [label, id] of Object.entries(vectors.vectors)) expect(handleIdOf(label)).toBe(id);
  });
});
