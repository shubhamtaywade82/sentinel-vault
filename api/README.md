# Sentinel Vault API

Rails 8.1 API-only backend for Sentinel Vault, replacing the Next.js route handlers in
`../src/app/api`. The Next.js UI is unchanged; it is not wired to this API yet (phase 6).

## Run it

Requires Ruby 4.0, PostgreSQL 17.

```bash
bin/setup --skip-server   # installs gems, generates .env with random secrets, prepares the DB
bin/rails db:seed         # optional demo data; prints client credentials once
bin/rails server          # http://localhost:4781
bundle exec rspec
```

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
  grant permissions, and a partial unique index allowing one active version per secret.

## API contract inventory

Paths and JSON shapes match `../src/lib/vault/client.ts`, which is the UI's contract.
Status per endpoint:

| Endpoint | Status |
|---|---|
| `GET health/live`, `GET health/ready`, `GET me` | Done |
| `GET/POST workspaces` | Done |
| `GET/POST admin/service_clients`, `POST …/:id/rotate_credential`, `POST …/:id/revoke` | Done |
| `GET grants`, `POST admin/grants`, `DELETE admin/grants/:id` | Done |
| `GET/POST secrets`, `GET secrets/:id` | Done |
| `GET/POST secrets/:id/versions`, `POST …/reveal`, `…/rotate`, `…/revoke`, `…/diff`, `GET …/events` | Done |
| `GET/POST connections`, `GET …/:id/status`, `POST …/:id/credential`, `POST …/:id/revoke` | Done (no provider calls) |
| `GET audit_events` | Done |
| `GET audit_events/export` (CSV) | Phase 6 |
| `POST connections/:id/refresh`, `…/reauthorize`, `…/recover`, `GET rotation_runs[/:id]` | Phase 5: refresh engine, Solid Queue jobs |
| `POST internal/watchdog` | Phase 5: replaced by a recurring Solid Queue job |
| `GET/POST secrets/:id/leases`, `GET leases`, `DELETE leases/:id`, `GET secrets/:id/usage` | Phase 5 |
| `dashboard/*` (stats, provider-health, client-preview, compliance, expiring-leases, audit-activity, anomalies, remediate) | Phase 6 |
| `admin/keys`, `admin/keys/rotate` | Replaced by KMS-managed key rotation; each version stores its `kms_key_ref` |
| `POST internal/seed`, `GET internal/demo-credentials` | Removed: use `bin/rails db:seed` |
| `GET openapi.json` | Phase 6 |

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
| Duplicate secret path | `409 conflict` | `422 validation_failed` |
| Plaintext value size | Unbounded | 64 KB; diff limited to 1,000 lines |

### Data migration

Existing SQLite data is demo-only and uses the v1 scheme with a different key hierarchy.
Re-seed instead of copying ciphertext. Genuine data would need a validated, audited
decrypt-and-re-encrypt migration.
