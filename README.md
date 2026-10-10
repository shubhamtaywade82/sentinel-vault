# Sentinel Vault

A Rails 8.1 API (repo root) behind a Next.js operations UI (`frontend/`). The UI proxies
every `/api/v1` request to Rails (`frontend/next.config.ts`, `VAULT_API_URL`, default
`http://localhost:4781`); the legacy route handlers in `frontend/src/app/api` no longer
receive traffic and go in phase 7.

## Run it

Requires Ruby 4.0, PostgreSQL 17, Bun.

```bash
bin/setup --skip-server   # gems, frontend packages, .env with random secrets, databases
bin/rails db:seed         # optional demo data; prints client credentials once
bin/dev                   # API :4781 + Solid Queue workers + UI :4750 (Procfile.dev)
bundle exec rspec
```

Open http://localhost:4750 and set the admin token (`VAULT_ADMIN_TOKEN` in `.env`) from the
header badge.

Connecting a bot or app to fetch its secrets: see [docs/CLIENT_GUIDE.md](docs/CLIENT_GUIDE.md)
(curl, Ruby and TypeScript).

## Configuration

Every variable is required in every environment. There are no defaults in code, and the
app refuses to boot without them (`app/lib/vault_config.rb`).

| Variable | Notes |
|---|---|
| `VAULT_ADMIN_TOKEN` | At least 32 characters. |
| `VAULT_KMS_PROVIDER` | `local` (development/test) or `aws_kms`. `local` is refused in production. |
| `VAULT_MASTER_KEY` | `local` only: base64 of 32 bytes. |
| `VAULT_KMS_KEY_ID` | `aws_kms` only: key id or ARN. Region and credentials come from the standard AWS chain. |
| `DATABASE_URL`, `CACHE_DATABASE_URL`, `QUEUE_DATABASE_URL` | Production only. |

## Security model

- **Encryption** (`app/services/encryption.rb`): AES-256-GCM envelope with a fresh data key
  per value. Both the value and the wrapped data key are bound to
  `(workspace_id, vault_secret_id, version_number)`, so a ciphertext copied to another
  record fails to decrypt. With AWS KMS the same context is the KMS encryption context,
  so every unwrap is attributable in CloudTrail. Scheme `aes-256-gcm-envelope-v2`.
- **Authorization**: bearer token resolves to the admin or one service client. Clients
  only ever query their own workspace; foreign ids return `*_not_found`. Every secret
  operation checks the client's grant for the exact permission.
- **Audit**: privileged writes record their audit row in the same transaction. Reveals
  and credential deliveries return plaintext only after the audit row commits. If the
  audit write fails, the request fails with `audit_persist_failed`. The table is
  append-only, enforced by a database trigger.
- **Integrity in PostgreSQL**: foreign keys, check constraints on every enum and on
  grant permissions, a partial unique index allowing one active version per secret, and a
  composite foreign key keeping each secret's current version within that secret.

## API contract inventory

Paths and JSON shapes match `../src/lib/vault/client.ts`, which is the UI's contract.
Status per endpoint:

| Endpoint | Status |
|---|---|
| Every call in `client.ts` | Done, except the rows below |
| `admin/keys`, `admin/keys/rotate` | Replaced by KMS-managed key rotation; each version stores its `kms_key_ref` |
| `POST internal/seed`, `GET internal/demo-credentials` | Removed: use `bin/rails db:seed`; the UI pastes a credential instead |
| `GET openapi.json` | Not ported: the UI never calls it |
| `POST internal/watchdog` | Kept for the UI button; the same sweep runs every minute as `RefreshSweepJob` |

### Intentional differences from the Next.js backend

| Area | Next.js | Rails |
|---|---|---|
| Client responses | Include `credentialDigest` | Omitted (unused by the UI) |
| Client credentials | Also written in plaintext to `vault-demo-credentials.json` | Returned once, never stored |
| Default admin token | `vault-admin-demo-token-CHANGE-ME` outside production | None; boot fails without one |
| Expired connection credential | Auto-refresh; if refresh fails, the expired token is returned | `422 credential_refresh_unavailable` |
| Revoked secret/connection | Reveal and credential still work | `409` / `422 reauthorization_required` |
| `connections/:id/credential` purpose | Any binding, including refresh tokens | `access_token` only |
| Rotate without `value` | Invents a random value | `422 validation_failed` |
| `revokeUpstream: true` | Provider failure logged, request succeeds | `422` until provider adapters exist |
| Rotate credential of a revoked client | Silently re-activates it | `409` (revocation is terminal) |
| `createdByClientId` param | Caller-controlled | Ignored; derived from the authenticated caller |
| `secrets/:id/events` for clients | Any grant | Requires `audit:read` |
| Source IP | Raw `X-Forwarded-For` | `request.remote_ip` (trusted proxies only) |
| Missing/invalid token on admin routes | `403 admin_required` | `401 unauthorized` (client tokens still get 403) |
| Plaintext value size | Unbounded | 64 KB; diff limited to 1,000 lines |
| Dhan "real" refresh | Posts a refresh token to a nonexistent endpoint | `RenewToken`, falling back to PIN + TOTP `generateAccessToken` (per the official SDK) |
| Generic OAuth token URL | One global `OAUTH_TOKEN_URL` | Per connection (`tokenUrl`, https only, SSRF-guarded) |
| Reauthorize | Marks the connection healthy without contacting the provider | Real re-authorization, or `manual_reauth_required` |
| Recover | Invents a 10-minute access expiry | Stores only expiries it is given |
| Remediate | Overwrites the secret with a random `ROT_…` value | Needs the new value, or a real provider refresh |
| Refresh while another runs | Returns a placeholder run | `409 rotation_in_progress` |
| Transient refresh failure | Waits for the next sweep | Solid Queue retry with backoff, capped at 5 attempts |
| Dashboard reads | Each poll writes an audit row | Not audited (reads only) |
| Client probing another tenant's id | Not found, not audited | Not found, audited for the owning tenant |
| CSV export | Formula cells pass through | `=`, `+`, `-`, `@` cells neutralised |
| Leases | Advisory; can claim any permission | Advisory; cannot exceed the client's grant |

### Key rotation

Each version stores the `kms_key_ref` that wrapped its data key.

- **`aws_kms`**: rotate inside KMS. Automatic key rotation keeps the same key id and
  stays transparent. To move to a new key, set `VAULT_KMS_KEY_ID` to it: new writes
  use it, and old versions still decrypt because the old key id is in their
  `kms_key_ref`. Keep the old key enabled until nothing references it.
- **`local`**: holds exactly one master key. Changing `VAULT_MASTER_KEY` makes every
  existing version undecryptable (`decryption_failed`, reported per request). There is
  no re-wrap tool. This is acceptable only because `local` is refused in production.
- **Not built yet**: a resumable re-wrap job that moves data keys onto a new key, so
  an old key can be retired. Needed before retiring any AWS key.

### Open items

- **Leases are advisory.** No authorization check reads them, as before. Decide whether a lease
  should grant time-boxed access before relying on them.
- **Admin identity.** One shared admin token, so admin actions carry no actor. Needs per-operator
  identity (e.g. SSO) before production.
- **Providers against real accounts.** Dhan and OAuth adapters are tested with stubbed HTTP only.
- **Rate limits behind a proxy.** Limits key on `request.remote_ip`; configure
  `config.action_dispatch.trusted_proxies` for the production load balancer so clients are not
  pooled under one address.
- **Phase 7.** Delete the legacy Next.js handlers, Prisma, SQLite and the Bun watchdog sidecar.

### Data migration

Existing SQLite data is demo-only and uses the v1 scheme with a different key hierarchy.
Re-seed instead of copying ciphertext. Genuine data would need a validated, audited
decrypt-and-re-encrypt migration.
