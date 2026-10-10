# Secret Vault — Canonical Contract

Single source of truth for the Secrets Vault build. Every subagent MUST read this file before
working and MUST conform to the names, fields, and shapes defined here. Shared TS types live in
`src/lib/vault/types.ts`, error codes in `src/lib/vault/errors.ts`, and the frontend API client in
`src/lib/vault/client.ts` — import those rather than redefining.

## 0. Stack

- Next.js 16 App Router, TypeScript 5, Tailwind CSS 4, shadcn/ui (New York), Lucide icons.
- Prisma + SQLite (`@/lib/db`). The schema primitive type can NOT be a list — use comma-separated
  `String` for permission sets.
- Backend-only crypto via Node.js `crypto` (AES-256-GCM). Never import crypto in client code.
- Background worker = a separate Bun mini-service on port 3030 that calls the vault's
  `POST /api/v1/internal/watchdog` endpoint on a schedule.

## 1. File layout

```
prisma/schema.prisma                       # 10 models (full schema in §3)
src/lib/db.ts                              # exists — Prisma client
src/lib/vault/
  types.ts                                  # shared TS types (contract — DO NOT redefine)
  errors.ts                                 # VaultError + error code catalog (contract)
  client.ts                                 # frontend API client (contract)
  crypto.ts                                 # envelope encrypt/decrypt (server only)
  key-service.ts                            # master key / KMS sim (server only)
  auth.ts                                   # bearer auth: resolveAdminClient / resolveClient (server)
  authorization.ts                          # grant checks (server)
  audit.ts                                  # recordEvent (server)
  seed.ts                                   # seed() — idempotent demo data (server)
  providers/
    index.ts                                # adapter registry
    dhan.ts                                 # Dhan OAuth2 refresh (simulated HTTP)
    oauth-generic.ts                        # generic OAuth2 refresh (simulated)
    api-key.ts                               # static API key (no refresh)
  refresh.ts                                # refresh engine: lease, adapter call, persist, activate (server)
src/app/api/v1/...                          # route handlers (see §4)
src/app/page.tsx                            # the only user route — full dashboard
src/app/layout.tsx                          # root layout — dark wrapper, fonts
src/components/vault/...                    # dashboard components
mini-services/vault-watchdog/               # Bun mini-service, port 3030
```

## 2. Auth model

Two bearer-token realms, both sent as `Authorization: Bearer <token>`.

### Admin realm
- Token compared (constant-time) against `process.env.VAULT_ADMIN_TOKEN`.
  In dev/seed it defaults to `vault-admin-demo-token-CHANGE-ME` if env unset.
- Admin can do everything: all `/admin/*`, `workspaces`, `secrets` create/list, `connections`,
  `rotation_runs`, `audit_events`, `grants`, `internal/watchdog`, `internal/seed`.
- Admin does NOT automatically get `value:read`. Reveal still requires a `value:read` grant OR
  an explicit `admin_reveal_ok=true` query flag set by the UI confirm flow. The UI always sends
  `admin_reveal_ok=true` for admin reveals after confirmation.

### Client realm
- Each `ServiceClient` has a high-entropy credential of the form `vlt_live_<32 hex>`.
- DB stores ONLY `credentialDigest = sha256(credential)` hex and `credentialPrefix` = first 10 chars.
- Auth: hash the supplied bearer, match `credentialDigest`, ensure `status="active"` and not
  expired/revoked. Update `lastUsedAt`.
- Authorization: every protected action checks `SecretAccessGrant` for `(serviceClientId, vaultSecretId)`
  with the required permission in the comma-separated `permissions` field.

Permissions (comma-separated string on `SecretAccessGrant.permissions`):
`metadata:read`, `value:read`, `version:create`, `rotate`, `revoke`, `connection:refresh`,
`audit:read`.

### `resolveAuth(req)` helper (in auth.ts)
Returns one of:
- `{ kind: "admin" }`
- `{ kind: "client", client: <ServiceClient with workspace> }`
- `{ kind: "none" }`
Throws `VaultError` 401 only when explicitly required; otherwise returns `none` so routes decide.

## 3. Prisma schema (EXACT — copy into prisma/schema.prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Workspace {
  id        String   @id @default(cuid())
  slug      String   @unique
  name      String
  status    String   @default("active")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  serviceClients         ServiceClient[]
  vaultSecrets           VaultSecret[]
  integrationConnections IntegrationConnection[]
  secretAccessEvents     SecretAccessEvent[]
}

model ServiceClient {
  id               String    @id @default(cuid())
  workspaceId      String
  publicId         String    @unique
  name             String
  clientType       String
  credentialDigest String    @unique
  credentialPrefix String
  status           String    @default("active")
  expiresAt        DateTime?
  lastUsedAt       DateTime?
  revokedAt        DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  workspace     Workspace           @relation(fields: [workspaceId], references: [id])
  grants        SecretAccessGrant[]
  accessEvents  SecretAccessEvent[]
}

model VaultSecret {
  id               String    @id @default(cuid())
  workspaceId      String
  path             String
  name             String
  kind             String
  classification   String    @default("confidential")
  environment      String    @default("production")
  provider         String?
  status           String    @default("active")
  expiresAt        DateTime?
  currentVersionId String?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@unique([workspaceId, path])

  workspace    Workspace            @relation(fields: [workspaceId], references: [id])
  versions     SecretVersion[]
  grants       SecretAccessGrant[]
  accessEvents SecretAccessEvent[]
  rotationRuns RotationRun[]
}

model SecretVersion {
  id               String    @id @default(cuid())
  vaultSecretId    String
  versionNumber    Int
  ciphertext       String
  encryptedDataKey String
  kmsKeyRef        String
  cryptoScheme     String    @default("aes-256-gcm-envelope-v1")
  status           String    @default("active")
  createdBy        String    @default("system")
  activatedAt      DateTime  @default(now())
  retiredAt        DateTime?
  createdAt        DateTime  @default(now())

  @@unique([vaultSecretId, versionNumber])

  vaultSecret   VaultSecret         @relation(fields: [vaultSecretId], references: [id])
  accessEvents SecretAccessEvent[]
  rotationRuns  RotationRun[]
}

model IntegrationConnection {
  id                     String    @id @default(cuid())
  workspaceId            String
  providerKey            String
  authMethod             String
  adapterKey             String
  providerAccountRef     String?
  status                 String    @default("active")
  accessExpiresAt        DateTime?
  refreshAfter           DateTime?
  lastRefreshedAt        DateTime?
  refreshLeaseExpiresAt  DateTime?
  refreshGeneration      Int       @default(0)
  lastErrorCode          String?
  reauthRequiredAt       DateTime?
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  workspace    Workspace                 @relation(fields: [workspaceId], references: [id])
  bindings     ConnectionSecretBinding[]
  rotationRuns RotationRun[]
}

model ConnectionSecretBinding {
  id            String   @id @default(cuid())
  connectionId  String
  vaultSecretId String
  purpose       String
  createdAt     DateTime @default(now())

  @@unique([connectionId, purpose])

  connection  IntegrationConnection @relation(fields: [connectionId], references: [id])
  vaultSecret VaultSecret            @relation(fields: [vaultSecretId], references: [id])
}

model SecretAccessGrant {
  id              String   @id @default(cuid())
  serviceClientId String
  vaultSecretId   String
  permissions     String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([serviceClientId, vaultSecretId])

  serviceClient ServiceClient @relation(fields: [serviceClientId], references: [id])
  vaultSecret   VaultSecret    @relation(fields: [vaultSecretId], references: [id])
}

model RotationRun {
  id              String    @id @default(cuid())
  connectionId    String?
  vaultSecretId   String?
  operation       String
  status          String    @default("pending")
  attemptCount    Int       @default(0)
  idempotencyKey  String    @unique
  runAfter        DateTime  @default(now())
  startedAt       DateTime?
  completedAt     DateTime?
  resultVersionId String?
  errorCode       String?
  leaseToken      String?
  leaseExpiresAt  DateTime?
  correlationId   String?
  createdAt       DateTime  @default(now())

  connection    IntegrationConnection? @relation(fields: [connectionId], references: [id])
  vaultSecret   VaultSecret?           @relation(fields: [vaultSecretId], references: [id])
  resultVersion SecretVersion?         @relation(fields: [resultVersionId], references: [id])
}

model SecretAccessEvent {
  id              String    @id @default(cuid())
  workspaceId     String?
  actorClientId   String?
  vaultSecretId   String?
  secretVersionId String?
  action          String
  outcome         String    @default("success")
  reasonCode      String?
  requestId       String?
  sourceIp        String?
  createdAt       DateTime  @default(now())

  workspace     Workspace?      @relation(fields: [workspaceId], references: [id])
  actorClient   ServiceClient?   @relation(fields: [actorClientId], references: [id])
  vaultSecret   VaultSecret?     @relation(fields: [vaultSecretId], references: [id])
  secretVersion SecretVersion?   @relation(fields: [secretVersionId], references: [id])
}

model SecretLease {
  id                String    @id @default(cuid())
  vaultSecretId     String
  serviceClientId   String
  grantedPermissions String
  issuedAt          DateTime  @default(now())
  expiresAt        DateTime
  revokedAt         DateTime?
  status           String    @default("active")
  createdAt         DateTime  @default(now())
}
```

Run `bun run db:push` after writing the schema. Prisma will regenerate `@prisma/client`.

## 4. API contract (`/api/v1/*`)

All responses use this envelope:

- Success: the payload object directly (e.g. `{ secrets: [...] }`).
- Error: `{ error: { code: "<code>", message: "<human>", details?: {...} } }` with proper HTTP status.

Standard status codes: 200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 429, 500, 503.

Every mutation that can be replayed safely MUST accept an optional `Idempotency-Key` request
header and reuse an existing `RotationRun` with that `idempotencyKey` if present.

Plaintext-bearing responses set `Cache-Control: no-store, private`.

### 4.1 Health
- `GET /api/v1/health/live` → 200 `{ status:"alive", ts }`
- `GET /api/v1/health/ready` → 200 `{ status:"ready", db:"ok", crypto:"ok", ts }` (503 if db/crypto fail; do NOT fail on provider availability)

### 4.2 Identity
- `GET /api/v1/me` → 200 `{ client: {...metadata..., workspaceSlug, permissions:["admin"] }, grants:[{ secretId, secretPath, secretName, permissions }] }`
  (admin realm returns `permissions:["admin"]` and empty grants)

### 4.3 Workspaces
- `GET /api/v1/workspaces` → 200 `{ workspaces: [...] }` (admin)
- `POST /api/v1/workspaces` body `{ slug, name }` → 201 `{ workspace: {...} }` (admin)

### 4.4 Service clients (admin)
- `GET /api/v1/admin/service_clients?workspaceId=` → 200 `{ clients: [...] }`
- `POST /api/v1/admin/service_clients` body `{ name, clientType, workspaceId, expiresInDays? }` → 201 `{ client: {...metadata, status, expiresAt}, credential:"vlt_live_..." }` (credential returned ONCE)
- `POST /api/v1/admin/service_clients/:id/rotate_credential` → 200 `{ client: {...}, credential:"vlt_live_..." }` (returns new credential once)
- `POST /api/v1/admin/service_clients/:id/revoke` → 200 `{ client: {..., status:"revoked", revokedAt } }`

### 4.5 Grants (admin)
- `GET /api/v1/grants?workspaceId=` → 200 `{ grants: [{ id, serviceClientId, serviceClientName, vaultSecretId, secretPath, secretName, permissions }] }` (admin)
- `POST /api/v1/admin/grants` body `{ serviceClientId, vaultSecretId, permissions }` → 201 `{ grant: {...} }`
- `DELETE /api/v1/admin/grants/:id` → 204

### 4.6 Secrets
- `GET /api/v1/secrets?workspaceId=` → 200 `{ secrets: [{ id, workspaceId, path, name, kind, classification, environment, provider, status, expiresAt, currentVersionId, currentVersionNumber, versionCount, createdAt, updatedAt }] }`
  (admin sees all in workspace; client sees only granted secrets)
- `POST /api/v1/secrets` body `{ workspaceId, path, name, kind, classification?, environment?, provider?, value, expiresInHours?, createdByClientId? }` → 201 `{ secret: {...metadata}, version: { id, versionNumber, status, activatedAt, createdBy } }` (admin)
- `GET /api/v1/secrets/:id` → 200 `{ secret: {...metadata}, versions:[{ id, versionNumber, status, createdBy, activatedAt, retiredAt }] }`
  (admin or `metadata:read` grant)
- `POST /api/v1/secrets/:id/versions` body `{ value, expiresInHours?, createdByClientId? }` → 201 `{ version: {...} }` (admin or `version:create` grant). Retires previous active version atomically, bumps `currentVersionId`.
- `GET /api/v1/secrets/:id/versions` → 200 `{ versions: [...] }`
- `POST /api/v1/secrets/:id/reveal` body `{ reason? }` (admin with `admin_reveal_ok=true` query, OR `value:read` grant) → 200 `{ secret:{...metadata}, version:{...metadata}, value:"<plaintext>" }`. Audit `secret.reveal`.
- `POST /api/v1/secrets/:id/rotate` body `{ value?, expiresInHours?, createdByClientId? }` → 201 `{ version: {...} }` (admin or `rotate` grant). Creates a new version. Audit `secret.rotate`.
- `POST /api/v1/secrets/:id/revoke` body `{ revokeUpstream? }` → 200 `{ secret: { status:"revoked", revokedAt } }` (admin or `revoke` grant). Audit `secret.revoke`.

### 4.7 Connections
- `GET /api/v1/connections?workspaceId=` → 200 `{ connections: [{ id, workspaceId, providerKey, authMethod, adapterKey, providerAccountRef, status, accessExpiresAt, refreshAfter, lastRefreshedAt, refreshGeneration, lastErrorCode, reauthRequiredAt, bindings:[{ id, purpose, vaultSecretId, secretPath }] }] }`
- `POST /api/v1/connections` body `{ workspaceId, providerKey, authMethod, adapterKey, providerAccountRef?, accessExpiresAt?, refreshAfter?, bindings:[{ purpose, secretId }] }` → 201 `{ connection: {...} }` (admin)
- `GET /api/v1/connections/:id/status` → 200 `{ connection: {...lifecycle...} }`
- `POST /api/v1/connections/:id/refresh` → 202 `{ rotationRun: { id, status, operation:"refresh" } }`. Creates a `RotationRun`, executes synchronously for the demo, returns final state in `rotationRun`. Audit `refresh.run`.
- `POST /api/v1/connections/:id/credential` body `{ purpose?:"access_token" }` → 200 `{ credential: { value:"<plaintext>", expiresAt, generation, refreshed:false, versionId } }`. Resolves current active version of the `access_token` binding, reveals it (audited `connection.credential`), never returns refresh token/TOTP seed. If expired and refreshable, refresh first then return.
- `POST /api/v1/connections/:id/reauthorize` → 202 `{ rotationRun:{ id, status, operation:"reauthorize" } }`. Marks `reauthRequiredAt=now`, status `reauth_required` if adapter doesn't support reauth; otherwise attempts.
- `POST /api/v1/connections/:id/revoke` → 200 `{ connection:{ status:"revoked" } }`. Adapter attempts provider-side revoke if supported.

### 4.8 Rotation runs
- `GET /api/v1/rotation_runs?status=&connectionId=&limit=` → 200 `{ runs: [{ id, connectionId, vaultSecretId, operation, status, attemptCount, idempotencyKey, runAfter, startedAt, completedAt, resultVersionId, errorCode, correlationId, createdAt }] }`
- `GET /api/v1/rotation_runs/:id` → 200 `{ run: {...} }`

### 4.9 Audit
- `GET /api/v1/audit_events?workspaceId=&limit=100&offset=0&action=&outcome=` → 200 `{ events: [{ id, workspaceId, actorClientId, actorClientName, vaultSecretId, secretPath, secretVersionId, action, outcome, reasonCode, requestId, sourceIp, createdAt }] }` (admin; or `audit:read` grant scoped to secret)

### 4.10 Internal (admin only)
- `POST /api/v1/internal/watchdog` body `{}` → 200 `{ checked:N, refreshed:[{ connectionId, status }], reauthRequired:[...], errors:[{ connectionId, errorCode }] }`
  - Finds connections where `status="active" AND refreshAfter <= now AND refreshLeaseExpiresAt < now`.
  - For each: claim lease (set `refreshLeaseExpiresAt=now+60s`, `refreshGeneration+=1`, lease token random),
    call adapter refresh, on success persist new `SecretVersion` for the `access_token` binding and
    activate it, set `lastRefreshedAt`, clear `lastErrorCode`, advance `refreshAfter` and `accessExpiresAt`.
    On permanent auth failure set `status="reauth_required"`, `reauthRequiredAt=now`, `lastErrorCode`.
    On transient failure increment `attemptCount`, leave status, set `lastErrorCode`.
- `POST /api/v1/internal/seed` body `{}` → 200 `{ ok:true, created:{...counts} }` (idempotent: skip if already seeded)

## 5. Crypto design (`src/lib/vault/crypto.ts` + `key-service.ts`)

- Master key: 32 bytes. From `process.env.VAULT_MASTER_KEY` (base64). If unset, derive once from
  `process.env.VAULT_MASTER_KEY || "vault-dev-master-key"` via `crypto.scryptSync` salted by
  `"vault-v1"` (dev only — log a clear warning). `kmsKeyRef = "local-master-v1"`.
- `encryptValue(plaintext, aadObject)`:
  - `dataKey = crypto.randomBytes(32)`
  - `nonce = crypto.randomBytes(12)`
  - AAD string = canonical JSON of `{ workspaceId, vaultSecretId, versionNumber }` (stable key order).
  - `cipher = AES-256-GCM(dataKey)`, setAAD(aadBytes), encrypt → ciphertext+tag (base64).
  - Wrap dataKey with master key using AES-256-GCM (its own nonce), `kmsKeyRef`.
  - Return `{ ciphertext, encryptedDataKey, kmsKeyRef, cryptoScheme:"aes-256-gcm-envelope-v1", nonce, wrappedNonce }` — store ciphertext/encryptedDataKey/kmsKeyRef/cryptoScheme in the DB; keep nonces either concatenated into ciphertext (preferred: `base64(nonce||ciphertext+tag)`).
  - RECOMMENDED single `ciphertext` field format: `base64(12-byte nonce || ciphertext || 16-byte tag)`. Same for `encryptedDataKey`. Simpler.
- `decryptValue({ ciphertext, encryptedDataKey, kmsKeyRef }, aadObject)`:
  - Unwrap dataKey with master key (verify tag).
  - Split nonce/tag, AES-256-GCM decrypt with AAD verification. Throws `VaultError("decryption_failed")` on tamper or AAD mismatch.
- AAD mismatch = cross-record move → denied. Add a security regression test concept in seed/comments.

## 6. Provider adapters (`src/lib/vault/providers/*`)

Each adapter exports:
```ts
export interface ProviderAdapter {
  key: string;                 // "dhan_v1", "oauth2_generic", "api_key_static"
  providerKey: string;         // "dhan", "oauth-generic", "api-key"
  supportsRefresh: boolean;
  supportsReauth: boolean;
  refresh(args: RefreshArgs): Promise<RefreshResult>;
  revoke?(args: RevokeArgs): Promise<{ ok: boolean; code?: string }>;
}
export interface RefreshArgs {
  connection: IntegrationConnectionRow;
  bindings: { purpose: string; secret: VaultSecretRow; decrypt: () => Promise<string> }[];
}
export interface RefreshResult {
  ok: boolean;
  newCredentials?: { purpose: string; value: string; expiresAt?: string }[];
  errorCode?: string;          // "invalid_grant" | "transient" | "rate_limited" | "provider_error"
  refreshTokensRotated?: { purpose: string; newValue: string }[];
}
```

- `dhan_v1`: simulated OAuth2 refresh. Uses `refresh_token` binding to "exchange". 70% chance
  success; rotates the refresh token (returns new `refresh_token`). Sets access expiry = now + 2h
  for the demo (configurable). On `Math.random()<0.15` return `invalid_grant` (permanent). On
  `<0.1` return `transient`.
- `oauth2_generic`: similar but access expiry = now + 1h, rotates refresh token.
- `api_key_static`: `supportsRefresh=false`. The watchdog marks `reauth_required` (manual rotation).

## 7. Refresh engine (`src/lib/vault/refresh.ts`)

`async function refreshConnection(connectionId, { manual?: boolean }): Promise<RotationRun>`

1. Load connection + bindings + secrets.
2. Atomic lease claim: `UPDATE ... SET refreshLeaseExpiresAt=now+60s, refreshGeneration=gen+1
   WHERE id=? AND (refreshLeaseExpiresAt IS NULL OR refreshLeaseExpiresAt < now)`. If 0 rows,
   return existing/running run as `status:"running"` (409-style, but we return the run).
3. Create `RotationRun{ operation:"refresh", status:"running", startedAt:now, attemptCount:++,
   idempotencyKey, leaseToken, leaseExpiresAt, correlationId, connectionId }`.
4. If adapter `supportsRefresh=false`: set run `status:"failed"`, errorCode
   `manual_rotation_required`, connection `status:"reauth_required"`, `reauthRequiredAt=now`,
   `lastErrorCode`. Audit. Return run.
5. Call adapter.refresh with a `decrypt` closure per binding (decrypts only when adapter asks).
6. Success: open a short TX — for each `newCredentials` entry, create a new `SecretVersion` (encrypt
   with AAD bound to that secret), retire the prior active version, set `currentVersionId`,
   update the secret's `expiresAt`. Update connection `lastRefreshedAt=now`,
   `accessExpiresAt=<expiresAt>`, `refreshAfter=<expiresAt - safetyMargin + jitter>`,
   `refreshGeneration` already bumped, clear `lastErrorCode`, `status="active"`. Run `status:"succeeded"`,
   `completedAt=now`, `resultVersionId=<access_token version>`. Audit `refresh.succeeded`.
7. Permanent failure (`invalid_grant`/`manual_rotation_required`): connection
   `status="reauth_required"`, `reauthRequiredAt=now`, `lastErrorCode=code`. Run `status:"failed"`,
   `errorCode=code`, `completedAt=now`. Audit `refresh.failed` reason `code`.
8. Transient failure: run `status:"pending"` (retry-eligible), `errorCode=code`, increment
   `attemptCount`, `runAfter=now + backoff`. Connection stays active, `lastErrorCode=code`. Audit
   `refresh.transient`.
9. Always clear the lease at the end of success/fail (set `refreshLeaseExpiresAt=null`).
10. Generation guard: before persisting, recheck `connection.refreshGeneration === run.expectedGen`;
    if changed, abort (status:"cancelled", errorCode:"stale_generation").

`safetyMargin` = 15 minutes, `jitter` = 0–5 minutes (for the demo, scale down: margin 2 min, jitter 1 min
so the watchdog shows activity quickly).

## 8. Seed spec (`src/lib/vault/seed.ts`)

Idempotent: skip if any `Workspace` with `slug="production"` exists.

Workspaces: `development` (Dev), `staging` (Staging), `production` (Production).

Service clients (in production unless noted): `algo-scalper-bot` (bot),
`nexum-gateway` (gateway), `web-backend` (app), `reporting-cli` (cli), `mcp-tools` (mcp).
Each gets a stored credential; the seed returns the credential map so the UI can show them ONCE
in a "Demo Credentials" panel. Persist credentials to a file `vault-demo-credentials.json` in
project root (gitignored conceptually) so refresh works across reloads.

Secrets (production, unless noted):
- `dhan/prod/access-token` (access_token, provider dhan) — bound to dhan connection as access_token
- `dhan/prod/refresh-token` (refresh_token, provider dhan) — bound as refresh_token
- `dhan/prod/totp-seed` (totp_seed, provider dhan) — NOT granted to bots
- `dhan/prod/client-id` (api_key) — used by adapter
- `broker/prod/api-key` (api_key, provider broker) — static
- `broker/prod/api-secret` (private_key, provider broker)
- `oauth/github/client-id` (api_key), `oauth/github/client-secret` (client_secret),
  `oauth/github/access-token` (access_token), `oauth/github/refresh-token` (refresh_token)
- `db/prod/connection-string` (connection_string)
- `signing/prod/private-key` (private_key)
- `web/prod/stripe-secret` (api_key)
- `staging/dhan/access-token`, `staging/dhan/refresh-token` (staging workspace)

Integration connections:
- `dhan-prod` (dhan, oauth2_refresh, dhan_v1): `accessExpiresAt` = now+90min, `refreshAfter` = now+45min
  (so watchdog refreshes it within a minute or two of the demo), status active.
- `dhan-staging`: `accessExpiresAt` = now+2h, refreshAfter = now+1h.
- `broker-prod` (broker, api_key, api_key_static): no expiry, supportsRefresh=false.
- `github-oauth` (oauth-generic, oauth2_refresh, oauth2_generic): `accessExpiresAt`=now+30min,
  `refreshAfter`=now+5min (refreshes very soon).
- `stuck-connection` (dhan, oauth2_refresh, dhan_v1): `status="reauth_required"`,
  `lastErrorCode="invalid_grant"`, `reauthRequiredAt`=now.

Grants (least privilege):
- `algo-scalper-bot` → `value:read` on `dhan/prod/access-token`, `metadata:read` on `dhan/prod/client-id`.
  NO access to refresh token or TOTP seed.
- `nexum-gateway` → `value:read` + `connection:refresh` on `dhan/prod/access-token`,
  `value:read` on `broker/prod/api-key`, `value:read` on `web/prod/stripe-secret`.
- `web-backend` → `value:read` on `db/prod/connection-string`, `web/prod/stripe-secret`,
  `oauth/github/access-token`.
- `reporting-cli` → `metadata:read` on a few secrets (no value).
- `mcp-tools` → `value:read` on `dhan/prod/access-token` only.

Seed also writes 6–8 `RotationRun` rows (historical) with mixed statuses and ~12 `SecretAccessEvent`
rows (metadata only — no values).

## 9. Frontend (`src/app/page.tsx` + `src/components/vault/*`)

### Layout
- Root wrapper `min-h-screen flex flex-col` with dark bg (`bg-[#0a0b0f]` or `bg-zinc-950`) — set on
  a wrapper div, not on `<html>`, per the white-background rule.
- Sticky top header: vault logo (a `ShieldCheck` Lucide icon in an emerald-tinted box), title
  "Sentinel Vault", subtitle "Secrets Operations Console". Right side: workspace `<Select>`,
  a `Health` pill (live → emerald dot), admin-token presence badge, "Run Watchdog" button.
- Left sidebar (`<aside>`, fixed width, hidden on mobile behind a Sheet): nav items with Lucide
  icons: Dashboard, Secrets, Service Clients, Connections, Rotation Runs, Audit Log, Access
  Grants, Workspaces. Active item: emerald left border + subtle bg.
- Main `<main className="flex-1 ...">` scrollable.
- Sticky footer (`mt-auto`): left "Sentinel Vault v0.1 · demo build", right "Status: nominal ·
  KMS: local-master-v1 · DB: sqlite". Respect safe-area on mobile (`pb-[env(safe-area-inset-bottom)]`).

### State
Use a small Zustand store (`useVaultStore`) for: current view, current workspaceId, admin token
(default `"vault-admin-demo-token-CHANGE-ME"`), and refresh tick counter. TanStack Query for
server state (or simple `useEffect`+fetch via the shared `client.ts` — either is fine; prefer the
shared client for consistency). The shared client auto-sends `Authorization: Bearer <adminToken>`
and the current `X-Workspace` is sent as `?workspaceId=` query where the endpoint supports it.

### Views

1. **Dashboard** — KPI cards (Total Secrets, Active Connections, Pending Rotations, Reauth Required,
   Audit Events 24h, Active Clients). A "Expiry Timeline" showing the next 6 connection/secret
   expiries (sorted). A "Recent Audit Events" compact list (last 10). A "Connection Health" panel
   listing each connection with status badge + next refresh. Use Recharts for a small area/bar
   chart of audit events over the last 7 buckets (synth from events if needed, or just counts).

2. **Secrets** — toolbar: search by path/name, filter by `kind` and `status`, "New Secret"
   button (opens a Dialog form: workspace, path, name, kind, classification, environment,
   provider, value, expiresInHours). Table columns: Path (mono), Kind, Classification badge,
   Environment, Status badge, Expires (relative), Versions (count), Updated. Row actions
   (via a dropdown menu): Reveal, New Version, Rotate, Revoke. Reveal opens a confirm Dialog
   ("This will decrypt and return the plaintext. Continue?") then a masked-then-revealed panel
   with copy button + "no-store" notice. Clicking a row opens a Sheet/drawer with version history
   (version number, status, createdBy, activatedAt, retiredAt) + grants for that secret.

3. **Service Clients** — table: Name, Type badge, Public ID (mono, prefix-only + copy full),
   Status, Expires, Last Used, Grants count. Actions: New Client (returns credential ONCE in a
   Dialog with copy + warning "you won't see this again"), Rotate Credential (same), Revoke.
   Clicking a row opens a drawer showing the client's grants (editable: add/remove via the grants
   endpoints).

4. **Connections** — table: Provider (icon + key), Adapter, Account ref, Status badge, Access
   Expires (relative + progress bar), Refresh After, Generation, Last Error. Actions: Status,
   Refresh (triggers `/refresh`, shows the rotation run result), Get Credential (calls
   `/credential`, shows the returned token in a reveal panel — the runtime path demo),
   Reauthorize, Revoke. Clicking a row → drawer with bindings (purpose → secret path) and
   lifecycle timeline.

5. **Rotation Runs** — table: Operation badge, Connection/Secret ref, Status badge, Attempts,
   Run After, Started, Completed, Error Code, Correlation ID (mono). Filter by status. Clicking
   a row → drawer with full detail + a mini timeline.

6. **Audit Log** — dense table, virtualized-ish (max-h with scroll + custom scrollbar). Columns:
   Time, Actor (client name or "admin"/"system"), Action badge, Resource (secret path or
   connection id), Outcome badge, Reason Code, Request ID (mono, truncated). Filter by action
   prefix, outcome, workspace. "No secret values are stored" notice banner at top.

7. **Access Grants** — a matrix view: rows = service clients, columns = secrets (top N + search),
   cell = permissions chips. Clicking a cell opens a popover/dialog to edit permissions
   (checkboxes for the 7 permission strings). Plus a list view toggle. New grant form.

8. **Workspaces** — cards grid: slug, name, status badge, counts (clients, secrets, connections).
   New workspace dialog.

### Visual language
- Status badges (use shadcn `Badge` variants + custom): `active` emerald, `refreshing` amber,
  `reauth_required` orange/amber-600, `revoked`/`error` rose, `retired`/`expired` zinc, `pending`
  sky/teal, `succeeded` emerald, `failed` rose, `running` amber, `cancelled` zinc. NO indigo/blue
  as primary; emerald + zinc + amber + rose palette.
- Mono font for paths, ids, tokens, ciphertext previews. Use `font-mono` + `tabular-nums`.
- Cards: `rounded-lg border border-zinc-800 bg-zinc-900/60`, `p-4`/`p-6`, subtle hover.
- Tables: shadcn `Table` with `border-zinc-800` dividers, hover row `hover:bg-zinc-800/40`.
- Subtle Framer Motion entrance on view change (`opacity` + small `y`).
- Loading: skeletons (shadcn `Skeleton`).
- Toasts via `sonner` for actions (created, rotated, revoked, errors).

### Accessibility & responsiveness
- Semantic `<header> <nav> <main> <footer>`. ARIA labels on icon buttons. Keyboard navigable.
- Mobile: sidebar collapses into a Sheet triggered from header; tables become horizontal-scroll
  or stacked cards on small screens (at least Secrets/Clients/Connections/Audit must remain usable).
- Touch targets ≥ 44px.

## 10. Error code catalog (`src/lib/vault/errors.ts`)

```
unauthorized                401
admin_required              403
secret_access_denied        403
grant_required              403
resource_not_found          404
workspace_not_found         404
secret_not_found            404
connection_not_found        404
version_not_found           404
client_not_found            404
conflict                    409
rotation_in_progress        409
stale_generation            409
credential_refresh_unavailable 422
reauthorization_required    422
manual_rotation_required    422
validation_failed           422
rate_limited                429
provider_unavailable        503
decryption_failed           500
internal_error              500
```

`class VaultError extends Error { code, status, details }`. `toResponse(error)` returns a Next.js
`Response` with the envelope. Helper `assert(cond, code, message)`.

## 11. Non-negotiable rules
- NEVER log/echo plaintext secret values. Audit records store NO values.
- Plaintaintext responses set `Cache-Control: no-store, private`.
- Mutation endpoints read `Idempotency-Key` header.
- The only user route is `/`. Everything else is `/api/...` or mini-service.
- Footer MUST be sticky (see §9 Layout).
