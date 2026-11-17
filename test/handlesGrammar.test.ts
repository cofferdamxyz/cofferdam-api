// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { handleIdOf, isStoredHandle, readHandle } from '../src/services/handles/grammar.js';
import sdkFixture from './fixtures/handles/handleAnchorTypes.json';
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

  it("agrees with cofferdam-sdk: the shared fixture's handle ids (handleAnchorTypes.json, claude/handles-sdk 6d8ec4f)", () => {
    expect(sdkFixture.handleIds.length).toBeGreaterThan(0);
    for (const { label, handleId } of sdkFixture.handleIds) {
      expect(isStoredHandle(label)).toBe(true);
      expect(handleIdOf(label)).toBe(handleId);
    }
  });

  it("agrees with the SDK's toHandle on its own cases, where the stored form is concerned", () => {
    // cofferdam-sdk packages/core/test/handle.test.ts: everything it refuses, the plane refuses.
    for (const bad of ['maria_silva', '_ana', '-ana', 'ana-', 'ab', 'a'.repeat(65), 'ana.luz', 'ana luz', 'ab--cd', 'xn--abc', 'josé', '💩💩💩', 'ana\u200d', '@@ana', '', null, undefined])
      expect(readHandle(bad), String(bad)).toBeNull();
    for (const [typed, stored] of [['Hoff', 'hoff'], ['@ana-luz', 'ana-luz'], ['ana123', 'ana123'], ['abc', 'abc'], ['a'.repeat(64), 'a'.repeat(64)]])
      expect(readHandle(typed)).toBe(stored);
    // The one difference, by design: what needs ENSIP-15 beyond ASCII case (full-width letters, spaces around) is the phone's to normalise.
    expect(readHandle('  ＡＮＡ  ')).toBeNull();
    // The meta-address shape the registry stores is the SDK's: 66 bytes, spending key then viewing key.
    for (const e of sdkFixture.epochs) expect(e.metaAddress).toMatch(/^0x(02|03)[0-9a-f]{64}(02|03)[0-9a-f]{64}$/);
  });
});
