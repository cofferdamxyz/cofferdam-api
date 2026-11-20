// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { acmeCertificateKey, certificateFacts, certificateStatus, deployedCertificate } from '../../xmtp/backend/src/certificate.js';
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
    expect(entry).toMatch(/deployedCertificate\(this\.env\)/);
    expect(entry).not.toMatch(/XMTP_DATABASE_URL|XMTP_APP_API_KEY|XMTP_R2_|XMTP_ACME_R2/);
  });
});

describe('deployedCertificate', () => {
  const now = new Date('2027-01-27T12:00:00Z');
  const store = (objects: Record<string, string>) => ({
    get: async (key: string) => (key in objects ? { text: async () => objects[key]! } : null),
  });

  it('reads the certificate Caddy keeps in the store, for the CA in use', async () => {
    expect(acmeCertificateKey('production')).toBe(
      'caddy/certificates/acme-v02.api.letsencrypt.org-directory/xmtp.cofferdam.xyz/xmtp.cofferdam.xyz.crt',
    );
    const answer = await deployedCertificate(
      { XMTP_ACME_CA: 'production', XMTP_TLS_STORE: store({ [acmeCertificateKey('production')]: UTC_PEM }) },
      now,
    );
    expect(answer).toMatchObject({ configured: true, source: 'acme', staging: false, daysLeft: 20 });
    const staging = await deployedCertificate(
      { XMTP_ACME_CA: 'staging', XMTP_TLS_STORE: store({ [acmeCertificateKey('staging')]: UTC_PEM }) },
      now,
    );
    expect(staging).toMatchObject({ source: 'acme', staging: true });
  });

  it('prefers the override pair, and says when nothing is issued yet', async () => {
    const both = await deployedCertificate(
      { XMTP_TLS_CERT: UTC_PEM, XMTP_TLS_KEY: 'k', XMTP_ACME_CA: 'production', XMTP_TLS_STORE: store({}) },
      now,
    );
    expect(both.source).toBe('override');
    expect(await deployedCertificate({ XMTP_ACME_CA: 'production', XMTP_TLS_STORE: store({}) }, now)).toEqual({
      configured: false,
      checkedAt: now.toISOString(),
    });
    expect((await deployedCertificate({}, now)).configured).toBe(false);
  });

  it('reports a store it cannot read, without throwing', async () => {
    const broken = { get: async () => { throw new Error('r2 down'); } };
    const answer = await deployedCertificate({ XMTP_ACME_CA: 'production', XMTP_TLS_STORE: broken }, now);
    expect(answer).toMatchObject({ configured: true, source: 'acme', error: 'certificate: store unreadable' });
  });
});
