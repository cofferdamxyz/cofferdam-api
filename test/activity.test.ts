// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { portalUrlFor } from '../src/services/activity.js';

describe('portalUrlFor', () => {
  const sepolia = 'https://portal.sqd.dev/datasets/base-sepolia';
  const mainnet = 'https://portal.sqd.dev/datasets/base-mainnet';

  it('uses the per-chain default without an override', () => {
    expect(portalUrlFor(84532)).toBe(sepolia);
    expect(portalUrlFor(8453)).toBe(mainnet);
  });

  it('applies the override only to the chain whose dataset it names', () => {
    const cloudSepolia = 'https://cloud.example/portal/datasets/base-sepolia';
    expect(portalUrlFor(84532, cloudSepolia)).toBe(cloudSepolia);
    // The deployed Sepolia value must never serve a mainnet request.
    expect(portalUrlFor(8453, sepolia)).toBe(mainnet);
    expect(portalUrlFor(8453, 'https://cloud.example/portal/datasets/base-mainnet')).toBe(
      'https://cloud.example/portal/datasets/base-mainnet',
    );
  });

  it('falls back to Sepolia for an unknown chain', () => {
    expect(portalUrlFor(1)).toBe(sepolia);
    expect(portalUrlFor(1, mainnet)).toBe(sepolia);
  });
});
