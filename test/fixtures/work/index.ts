// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed access to the Work pipeline's synthetic fixtures: de-identified CV
 * blocks with gold fields (`cv-blocks.json`) and the hirer prompt set
 * (`hirer-prompts.json`), in en-US, pt-BR and es-MX. Nothing here is real
 * personal data; `test/workFixtures.test.ts` holds both files to the plane's
 * own de-identification check.
 */

import cvJson from './cv-blocks.json';
import hirerJson from './hirer-prompts.json';

export type FixtureLocale = 'en-US' | 'pt-BR' | 'es-MX';

export interface FixtureBlock {
  id: string;
  kind: string;
  lang: string;
  text: string;
  /** Gold fields: exact spans of `text`, numbers, and dates as YYYY or YYYY-MM. */
  expected: Record<string, unknown>;
}

export interface FixtureCv {
  id: string;
  locale: FixtureLocale;
  /** The coarse projection the worker would publish: a region and a scope, never a position. */
  listing: { region: string; scope: 'onsite' | 'remote'; tier: number };
  blocks: FixtureBlock[];
}

export interface RefusedFixture {
  id: string;
  reason: string;
  block: { kind: string; lang: string; text: string };
}

export interface HirerExpected {
  task: string | null;
  when: string | null;
  budgetUsd: number | null;
  credential: string | null;
  language: string | null;
  recurrence: string | null;
  scope: 'onsite' | 'remote';
  refuse: 'harmful' | 'injection' | null;
}

export interface HirerPrompt {
  id: string;
  locale: FixtureLocale;
  region: string;
  text: string;
  expected: HirerExpected;
}

export const FIXTURE_CVS = cvJson.cvs as FixtureCv[];
export const REFUSED_BLOCKS = cvJson.refused as RefusedFixture[];
export const HIRER_PROMPTS = hirerJson.prompts as HirerPrompt[];

/** Every CV block with the CV it belongs to. */
export function fixtureBlocks(): { cv: FixtureCv; block: FixtureBlock }[] {
  return FIXTURE_CVS.flatMap((cv) => cv.blocks.map((block) => ({ cv, block })));
}
