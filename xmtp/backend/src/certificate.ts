// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the Ops bot may know about the backend's TLS certificate (workspace
 * decision 0042, amended 2026-11-19): its validity and its names, read from the
 * `XMTP_TLS_CERT` secret the container serves. Never the key, never the PEM.
 *
 * A small DER reader, enough for an X.509 leaf: TBSCertificate's validity and
 * the subjectAltName extension's DNS names. Anything it cannot read throws.
 */

export interface CertificateFacts {
  notBefore: string;
  notAfter: string;
  dnsNames: string[];
}

interface Node {
  tag: number;
  start: number; // first content byte
  end: number; // one past the last content byte
}

function readNode(der: Uint8Array, at: number): Node {
  if (at + 2 > der.length) throw new Error('certificate: truncated');
  const tag = der[at]!;
  let len = der[at + 1]!;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > der.length) throw new Error('certificate: bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i]!;
    start += n;
  }
  const end = start + len;
  if (end > der.length) throw new Error('certificate: truncated');
  return { tag, start, end };
}

function children(der: Uint8Array, node: Node): Node[] {
  const out: Node[] = [];
  for (let at = node.start; at < node.end; ) {
    const child = readNode(der, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

const SEQUENCE = 0x30;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;
/** 2.5.29.17, subjectAltName. */
const SAN_OID = [0x55, 0x1d, 0x11];

function readTime(der: Uint8Array, node: Node): string {
  const text = new TextDecoder().decode(der.subarray(node.start, node.end));
  let m: RegExpMatchArray | null;
  if (node.tag === UTC_TIME && (m = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    const yy = Number(m[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy; // RFC 5280 4.1.2.5.1
    return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString();
  }
  if (node.tag === GENERALIZED_TIME && (m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString();
  }
  throw new Error('certificate: unreadable time');
}

function sameBytes(der: Uint8Array, node: Node, bytes: number[]): boolean {
  return node.end - node.start === bytes.length && bytes.every((b, i) => der[node.start + i] === b);
}

function readDnsNames(der: Uint8Array, extensionsWrapper: Node): string[] {
  const [extensions] = children(der, extensionsWrapper);
  if (!extensions || extensions.tag !== SEQUENCE) return [];
  for (const ext of children(der, extensions)) {
    const parts = children(der, ext);
    const oid = parts[0];
    if (!oid || oid.tag !== 0x06 || !sameBytes(der, oid, SAN_OID)) continue;
    const value = parts[parts.length - 1]!; // OCTET STRING, after an optional critical flag
    const [names] = children(der, value);
    if (!names || names.tag !== SEQUENCE) return [];
    return children(der, names)
      .filter((n) => n.tag === 0x82) // [2] dNSName
      .map((n) => new TextDecoder().decode(der.subarray(n.start, n.end)));
  }
  return [];
}

/** The first certificate of a PEM chain (the leaf), as DER. */
export function leafDer(pem: string): Uint8Array {
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!m) throw new Error('certificate: no PEM certificate');
  const bin = atob(m[1]!.replace(/\s+/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function certificateFacts(pem: string): CertificateFacts {
  const der = leafDer(pem);
  const cert = readNode(der, 0);
  const [tbs] = children(der, cert);
  if (cert.tag !== SEQUENCE || !tbs || tbs.tag !== SEQUENCE) throw new Error('certificate: not X.509');
  const fields = children(der, tbs);
  // An explicit [0] version comes first in v3 certificates.
  const base = fields[0]?.tag === 0xa0 ? 1 : 0;
  const validity = fields[base + 3];
  if (!validity || validity.tag !== SEQUENCE) throw new Error('certificate: no validity');
  const [notBefore, notAfter] = children(der, validity);
  if (!notBefore || !notAfter) throw new Error('certificate: no validity');
  const extensions = fields.find((f) => f.tag === 0xa3);
  return {
    notBefore: readTime(der, notBefore),
    notAfter: readTime(der, notAfter),
    dnsNames: extensions ? readDnsNames(der, extensions) : [],
  };
}

export interface CertificateStatusAnswer {
  /** Whether XMTP_TLS_CERT is set on the deployed Worker. */
  configured: boolean;
  notBefore?: string;
  notAfter?: string;
  dnsNames?: string[];
  /** Whole days until notAfter, rounded down (negative once expired). */
  daysLeft?: number;
  /** Set when the secret is there but unreadable; never its contents. */
  error?: string;
  checkedAt: string;
}

export function certificateStatus(pem: string | undefined, now: Date = new Date()): CertificateStatusAnswer {
  const checkedAt = now.toISOString();
  if (!pem || pem.trim() === '') return { configured: false, checkedAt };
  try {
    const facts = certificateFacts(pem);
    const daysLeft = Math.floor((Date.parse(facts.notAfter) - now.getTime()) / 86_400_000);
    return { configured: true, ...facts, daysLeft, checkedAt };
  } catch (err) {
    return { configured: true, error: err instanceof Error ? err.message : 'certificate: unreadable', checkedAt };
  }
}
