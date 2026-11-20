// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { certificateFacts, certificateStatus } from '../../xmtp/backend/src/certificate.js';
import {
  GENERALIZED_PEM,
  NO_SAN_PEM,
  REAL_CHAIN_PEM,
  REAL_DNS_NAMES,
  REAL_FACTS,
  UTC_PEM,
} from '../fixtures/xmtp/certificates.js';

describe('certificateFacts (decision 0042, amended 2026-11-19)', () => {
  it('reads UTCTime validity and every DNS name', () => {
    expect(certificateFacts(UTC_PEM)).toEqual({
      notBefore: '2026-11-19T00:00:00.000Z',
      notAfter: '2027-02-17T00:00:00.000Z',
      dnsNames: ['xmtp.cofferdam.xyz', 'www.example.test'],
    });
  });

  it('reads GeneralizedTime past 2049', () => {
    expect(certificateFacts(GENERALIZED_PEM).notAfter).toBe('2051-01-01T12:00:00.000Z');
  });

  it('answers no names for a certificate without extensions', () => {
    expect(certificateFacts(NO_SAN_PEM)).toEqual({
      notBefore: '2026-11-19T00:00:00.000Z',
      notAfter: '2026-12-19T00:00:00.000Z',
      dnsNames: [],
    });
  });

  it('reads the leaf of a real CA-issued chain as OpenSSL does', () => {
    expect(certificateFacts(REAL_CHAIN_PEM)).toEqual({ ...REAL_FACTS, dnsNames: REAL_DNS_NAMES });
  });

  it('throws on anything but a PEM certificate', () => {
    expect(() => certificateFacts('not a pem')).toThrow(/no PEM/);
    expect(() => certificateFacts('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow(/certificate:/);
  });
});

describe('certificateStatus', () => {
  const now = new Date('2027-01-27T12:00:00Z');

  it('counts whole days left and goes negative once expired', () => {
    expect(certificateStatus(UTC_PEM, now)).toMatchObject({ configured: true, daysLeft: 20 });
    expect(certificateStatus(NO_SAN_PEM, now).daysLeft).toBeLessThan(0);
  });

  it('says when no certificate is set', () => {
    expect(certificateStatus(undefined, now)).toEqual({ configured: false, checkedAt: now.toISOString() });
    expect(certificateStatus('  ', now).configured).toBe(false);
  });

  it('reports an unreadable secret without echoing it', () => {
    const answer = certificateStatus('-----BEGIN CERTIFICATE-----\nc2VjcmV0\n-----END CERTIFICATE-----', now);
    expect(answer.configured).toBe(true);
    expect(answer.error).toMatch(/^certificate: /);
    expect(JSON.stringify(answer)).not.toContain('c2VjcmV0');
  });

  it('is served by a named entrypoint that reads only the certificate', () => {
    const index = readFileSync(join(__dirname, '../../xmtp/backend/src/index.ts'), 'utf8');
    const entry = index.slice(index.indexOf('export class CertificateStatus'), index.indexOf('export default'));
    expect(entry).toMatch(/certificateStatus\(this\.env\.XMTP_TLS_CERT\)/);
    expect(entry).not.toMatch(/XMTP_TLS_KEY|XMTP_DATABASE_URL|XMTP_APP_API_KEY|XMTP_R2_/);
  });
});
