// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `CompanyConsumerLink` — the vertical → global-company grant
 * (ENTERPRISE_MODULE_PLAN.md §4.11, rev-7.4c).
 *
 * This is the one record that lives in the SHARED Cofferdam company plane
 * (this Worker), NOT in any per-consumer database. A consumer (OffshoreSync
 * maritime, a construction vertical, or cofferdam.xyz/enterprise) requests a
 * scoped link to a company's global `companyAnchor`; the company's it_admin
 * authorises it. Per-consumer apps keep a read-cached mirror for their own
 * route guards.
 *
 * Storage: Cloudflare KV. Key layout makes the §4.11 uniqueness constraint
 * (one ACTIVE link per (companyAnchor, consumerId)) a direct get/put, and
 * "list a company's links" a prefix scan:
 *
 *   link:<companyAnchor>:<consumerId>   → CompanyConsumerLink (JSON)
 *
 * Listing by `consumerId` alone would need a secondary index (or D1) — out
 * of scope for this scaffold; noted in the route handler.
 */

import type { CompanyAnchor } from './company.js';

// ── Grant vocabulary (mirrors §4.11) ───────────────────────────────────

export type LinkStatus = 'pending' | 'active' | 'suspended' | 'revoked';

/**
 * Capability scopes. Work-sourcing + proposal rights only — NEVER
 * treasury-owner or key-custody, which stay on-chain with the company Safe
 * and require the company's own signers (§6.D).
 */
export type LinkScope =
  | 'vacancy:post' // create vacancies/contracts under the company in this vertical
  | 'org:read' // read the OrgRoot for matching — pseudonyms only, no PII (§6.C.2)
  | 'contract:propose' // propose escrow contracts that settle to the company treasury
  | 'witness:propose' // propose scope-bound witness delegations (company still signs)
  | 'payroll:submit'; // submit net-pay runs into the company's payroll pipeline

export const LINK_SCOPES: readonly LinkScope[] = [
  'vacancy:post',
  'org:read',
  'contract:propose',
  'witness:propose',
  'payroll:submit',
];

export type InitiatedVia = 'consumer_claim' | 'dashboard_install';

export interface CompanyConsumerLink {
  companyAnchor: CompanyAnchor; // global join key (§4.1)
  canonicalDomain: string; // the verified handle, for display
  consumerId: string; // 'offshoresync' | 'cofferdam-enterprise' | 'acme-construction' | …
  vertical: string; // 'maritime' | 'construction' | 'medical_staffing' | …
  status: LinkStatus;
  scopes: LinkScope[];
  grantedByMemberRef: string | null; // the it_admin who authorised the link
  initiatedVia: InitiatedVia;
  grantedAt: string | null; // ISO-8601
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── KV-backed store ─────────────────────────────────────────────────────

/** True iff every entry of `scopes` is a recognised `LinkScope`. */
export function areValidScopes(scopes: unknown): scopes is LinkScope[] {
  return (
    Array.isArray(scopes) &&
    scopes.every((s) => (LINK_SCOPES as readonly string[]).includes(s as string))
  );
}

export class CompanyLinkStore {
  constructor(private readonly kv: KVNamespace) {}

  private key(companyAnchor: CompanyAnchor, consumerId: string): string {
    return `link:${companyAnchor.toLowerCase()}:${consumerId}`;
  }

  async get(companyAnchor: CompanyAnchor, consumerId: string): Promise<CompanyConsumerLink | null> {
    return this.kv.get<CompanyConsumerLink>(this.key(companyAnchor, consumerId), 'json');
  }

  async put(link: CompanyConsumerLink): Promise<void> {
    await this.kv.put(this.key(link.companyAnchor, link.consumerId), JSON.stringify(link));
  }

  /** All links for a company (active + historical), via prefix scan. */
  async listByCompany(companyAnchor: CompanyAnchor): Promise<CompanyConsumerLink[]> {
    const prefix = `link:${companyAnchor.toLowerCase()}:`;
    const out: CompanyConsumerLink[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor });
      for (const k of page.keys) {
        const link = await this.kv.get<CompanyConsumerLink>(k.name, 'json');
        if (link) out.push(link);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }
}
