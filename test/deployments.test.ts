import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SEPOLIA_DEPLOYMENTS } from '../src/chain/deployments.js';

const WRANGLER = new URL('../wrangler.jsonc', import.meta.url);
/** base-contracts beside this repository (the Mac); a cloud clone without it skips that check. */
const BASE_SEPOLIA_JSON = new URL('../../base-contracts/deployments/baseSepolia.json', import.meta.url);
/** Listed in baseSepolia.json but superseded, so left out of the table on purpose (the workspace TODO's leftovers). */
const NOT_MIRRORED = new Set(['MockGroth16Verifier']);

describe('the Base Sepolia deployments table', () => {
  it("holds the handle anchor wrangler.jsonc's HANDLE_ANCHOR_ADDRESS names", () => {
    const anchor = /"HANDLE_ANCHOR_ADDRESS":\s*"(0x[0-9a-fA-F]{40})"/.exec(readFileSync(WRANGLER, 'utf8'))?.[1];
    expect(anchor).toBe(SEPOLIA_DEPLOYMENTS.CofferdamHandleAnchor.address);
  });

  it.skipIf(!existsSync(BASE_SEPOLIA_JSON))('mirrors every address in base-contracts deployments/baseSepolia.json', () => {
    const json = JSON.parse(readFileSync(BASE_SEPOLIA_JSON, 'utf8')) as Record<string, { address: string }>;
    const ours = new Set(Object.values(SEPOLIA_DEPLOYMENTS).map((d) => d.address.toLowerCase()));
    const missing = Object.entries(json)
      .filter(([name, d]) => !NOT_MIRRORED.has(name) && !ours.has(d.address.toLowerCase()))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});
