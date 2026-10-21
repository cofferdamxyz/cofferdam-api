// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { PRODUCT_FACTS, PRODUCT_FACTS_SOURCES } from '../src/services/chat/facts.generated.js';
import { SYSTEM_PROMPT, answerSystem } from '../src/services/chat/run.js';
// The compiler is plain JavaScript so the Mac and the cloud run it without a build.
// @ts-expect-error untyped script
import { compile, render, skillsDir } from '../scripts/compile-skills.mjs';

/** Prompt tokens the facts may cost per turn, about chars / 4 (decision 0048). */
const TOKEN_BUDGET = 800;

const JARGON = /\b(crypto|blockchain|web3|wallet|token|on-chain|onchain|gas|stablecoin|seed phrase|nullifier|attester|paymaster|sepolia)\b/i;
const INTERNAL = /(0x[0-9a-fA-F]{8,}|@cf\/|cofferdam-(api|app|sdk)|wrangler|durable object)/i;

describe('the product facts (decision 0048)', () => {
  it('compile from the workspace skills and are committed up to date', () => {
    const dir = skillsDir();
    if (!dir) return; // outside a workspace clone the committed file is what ships
    const fresh = render(compile(dir));
    const committed = render({ block: PRODUCT_FACTS, sources: [...PRODUCT_FACTS_SOURCES] });
    expect(committed).toBe(fresh);
  });

  it('stay within the token budget and carry only built facts and not-yet lines', () => {
    expect(PRODUCT_FACTS.length / 4).toBeLessThanOrEqual(TOKEN_BUDGET);
    const lines = PRODUCT_FACTS.split('\n');
    expect(lines[0]).toMatch(/^Facts about Cofferdam/);
    for (const line of lines.slice(1)) expect(line).toMatch(/^- (Not yet: )?\S/);
    expect(lines.filter((l) => l.startsWith('- Not yet: ')).length).toBeGreaterThan(0);
    expect(PRODUCT_FACTS_SOURCES.map((s) => s.name)).toContain('cofferdam-basics');
  });

  it('name no jargon, no address, no internal system', () => {
    expect(PRODUCT_FACTS).not.toMatch(JARGON);
    expect(PRODUCT_FACTS).not.toMatch(INTERNAL);
  });

  it('ride in the system prompt after the rules', () => {
    const system = answerSystem();
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain(PRODUCT_FACTS);
    expect(system).toContain('No employer, hirer, app or Cofferdam itself can see your Vault');
  });
});
