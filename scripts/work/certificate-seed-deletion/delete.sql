-- Deletes the curated certificate seed from D1 cofferdam-work (workspace decision 0070, the founder's rulings
-- of 2026-10-30: the 24 seed credentials are deleted, and certificates snap like skills). The seed went in on
-- 2026-10-24: 24 tokens and 156 labels, each label one vector in token-registry-v1 (label-ids.txt holds their
-- ids). On 2026-10-30 D1 also held one alias a snap observed on a seed token, no decision that chose one, and
-- no listing at all. Every certificate token is the seed's: migration 0001 admits a certificate only with
-- source 'seed', and that CHECK stays until Vault minting changes it.
--
-- Run it once, from cofferdam-api, after the vectors are deleted (runbook: docs/runbooks/cloudflare-deploys.md,
-- Cofferdam Work resources, The certificate seed's deletion):
--   direnv exec .. yarn wrangler d1 execute cofferdam-work --remote --file=scripts/work/certificate-seed-deletion/delete.sql
-- The file is one transaction, and a second run deletes nothing. The rows that reference a token go first:
-- registry_decisions.token and registry_labels.token reference registry_tokens.token.

-- 1. The decisions that chose a seed token, and the aliases snaps observed on one.
DELETE FROM registry_decisions WHERE token IN (SELECT token FROM registry_tokens WHERE kind = 'cert' AND source = 'seed');
DELETE FROM registry_labels WHERE kind = 'observed' AND token IN (SELECT token FROM registry_tokens WHERE kind = 'cert' AND source = 'seed');

-- 2. The seed's own labels (156, each one vector).
DELETE FROM registry_labels WHERE token IN (SELECT token FROM registry_tokens WHERE kind = 'cert' AND source = 'seed');

-- 3. The tokens.
DELETE FROM registry_tokens WHERE kind = 'cert' AND source = 'seed';
