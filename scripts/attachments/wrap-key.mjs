#!/usr/bin/env node
// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Makes the key the attachment issuer's private keys are wrapped under (workspace decision 0093): 32 random bytes,
// base64, the secret ATTACHMENT_KEY_WRAP, written into a new file readable by its owner only and never printed. The
// issuer keys themselves are made by the plane, per 30-day epoch, inside AttachmentIssuerDO; this key never rotates.
// Replacing it makes the object make the live epochs again under the new key: their public keys change, and every
// token phones hold for them stops verifying.
//
//   node scripts/attachments/wrap-key.mjs ../cofferdam-secrets/attachment-key-wrap
//
// Then, from the workspace (vault first, docs/runbooks/cloudflare-deploys.md, Attachment tokens):
//   scripts/secrets/push.sh attachment-key-wrap
//   cd cofferdam-api && direnv exec .. yarn wrangler secret put ATTACHMENT_KEY_WRAP < ../cofferdam-secrets/attachment-key-wrap
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: wrap-key.mjs <new file for the key>');
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`wrap-key: ${out} exists; replacing the wrap key re-makes the live epochs and kills phones' tokens, a decision of its own`);
  process.exit(1);
}
const fd = openSync(out, 'wx', 0o600);
writeSync(fd, Buffer.from(randomBytes(32)).toString('base64'));
closeSync(fd);
console.error(`wrap-key: wrote a 32-byte key to ${out} (mode 600)`);
