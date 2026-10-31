// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { DRAFT_LIMITS, listingText, listingTextWithin, withoutLastClaims, type ListingDraft } from '../src/services/work/listings.js';

const draft = (titles: number, skills: number, certificates: number, chars = 30): ListingDraft => ({
  pseudonym: 'p',
  profileId: 'a',
  region: 'br-rj',
  scope: 'onsite',
  tier: 1,
  lang: 'pt',
  titles: Array.from({ length: titles }, (_, i) => `título ${i} `.padEnd(chars, 'x')),
  skills: Array.from({ length: skills }, (_, i) => `habilidade ${i} `.padEnd(chars, 'y')),
  certificates: Array.from({ length: certificates }, (_, i) => `certificado ${i} `.padEnd(chars, 'z')),
  languages: [],
});

/** An embedder that takes a text up to `limit` characters, counting its calls. */
const embedderOf = (limit: number) => {
  const calls: string[] = [];
  return { calls, accepts: async (text: string) => (calls.push(text), text.length <= limit) };
};

describe('the listing text within the embedder', () => {
  it('drops certificates from the last, then skills from the last, and never a title', () => {
    const d = draft(2, 3, 2);
    expect(withoutLastClaims(d, 0)).toEqual(d);
    expect(withoutLastClaims(d, 1).certificates).toEqual(d.certificates.slice(0, 1));
    expect(withoutLastClaims(d, 3)).toMatchObject({ titles: d.titles, skills: d.skills.slice(0, 2), certificates: [] });
    expect(withoutLastClaims(d, 99)).toMatchObject({ titles: d.titles, skills: [], certificates: [] });
  });

  it('takes a suffix off with each drop, so fewer claims never make a longer text', () => {
    const d = draft(5, 30, 20, 120);
    for (let n = 0; n < 50; n++) expect(listingText(withoutLastClaims(d, n), []).startsWith(listingText(withoutLastClaims(d, n + 1), []))).toBe(true);
  });

  it('sends the whole text when the embedder takes it, in one call', async () => {
    const d = draft(2, 5, 1);
    const e = embedderOf(10_000);
    await expect(listingTextWithin(d, e.accepts)).resolves.toEqual({ text: listingText(d, []), dropped: 0 });
    expect(e.calls).toHaveLength(1);
  });

  it('finds the fewest drops the embedder takes, halving, for the most a draft allows', async () => {
    const d = draft(DRAFT_LIMITS.titles, DRAFT_LIMITS.skills, DRAFT_LIMITS.certificates, DRAFT_LIMITS.chars);
    const e = embedderOf(3_469);
    const out = await listingTextWithin(d, e.accepts);
    expect(out.text.length).toBeLessThanOrEqual(3_469);
    expect(listingText(withoutLastClaims(d, out.dropped - 1), []).length).toBeGreaterThan(3_469);
    expect(out.text).toBe(listingText(withoutLastClaims(d, out.dropped), []));
    expect(out.text.startsWith(d.titles.join('; '))).toBe(true);
    // The whole text, the titles alone, then halving 50 drops.
    expect(e.calls.length).toBeLessThanOrEqual(2 + Math.ceil(Math.log2(DRAFT_LIMITS.skills + DRAFT_LIMITS.certificates)));
  });

  it('refuses a draft whose titles alone the embedder refuses', async () => {
    await expect(listingTextWithin(draft(5, 2, 0, 120), embedderOf(100).accepts)).rejects.toThrow(/titles alone/);
  });
});
