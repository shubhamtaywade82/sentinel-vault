// Sentinel Vault — idempotent seed.
// See VAULT_CONTRACT.md §8 for the canonical spec. This module is server-only.
//
// Exports:
//   interface SeedResult { ok: boolean; created: Record<string, number>; credentials: Record<string, string> }
//   async function seed(): Promise<SeedResult>
//   async function isSeeded(): Promise<boolean>
//   async function upgradeSeedEncryption(): Promise<number>   // re-encrypts placeholder versions
//
// Idempotency rules:
//   - isSeeded() === true iff a Workspace with slug="production" exists.
//   - seed() short-circuits when isSeeded() is true. However, if every SecretVersion in
//     the production workspace still carries the "SEED_PENDING_ENCRYPTION:" placeholder
//     (i.e. crypto module was unavailable during the first seed), seed() will instead
//     call upgradeSeedEncryption() to re-encrypt in place and return current counts.
//   - On a fresh seed, full client credentials are written to vault-demo-credentials.json
//     in the project root. On an already-seeded re-entry, the credential map is read
//     back from that file (empty map if the file is missing — credentials are NOT
//     re-derivable; only digests are persisted).

import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = path.join(process.cwd(), 'vault-demo-credentials.json')
const PENDING_PREFIX = 'SEED_PENDING_ENCRYPTION:'
const ADMIN_TOKEN_DEFAULT = 'vault-admin-demo-token-CHANGE-ME'
const CRYPTO_SCHEME = 'aes-256-gcm-envelope-v1'
const KMS_KEY_REF = 'local-master-v1'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeedResult {
  ok: boolean
  created: Record<string, number>
  credentials: Record<string, string>
}

type EncryptorModule = typeof import('./crypto')

// ---------------------------------------------------------------------------
// Small crypto / random helpers
// ---------------------------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
function randomAlnum(len: number): string {
  const buf = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALNUM[buf[i] % ALNUM.length]
  return out
}

function base64Encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function base64Decode(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8')
}

function minutesFromNow(min: number): Date {
  return new Date(Date.now() + min * 60_000)
}
function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60_000)
}
function daysFromNow(d: number): Date {
  return new Date(Date.now() + d * 24 * 60 * 60_000)
}
function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60_000)
}
function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60_000)
}
function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 24 * 60 * 60_000)
}

function uuid(): string {
  // randomUUID already returns a 36-char uuid; we use it for correlation/request ids.
  return randomUUID()
}

// ---------------------------------------------------------------------------
// Credentials file IO
// ---------------------------------------------------------------------------

interface CredentialsFile {
  admin: string
  clients: Record<string, string>
}

async function readCredentialsFile(): Promise<CredentialsFile | null> {
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CredentialsFile>
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      admin: typeof parsed.admin === 'string' ? parsed.admin : ADMIN_TOKEN_DEFAULT,
      clients:
        parsed.clients && typeof parsed.clients === 'object'
          ? (parsed.clients as Record<string, string>)
          : {},
    }
  } catch {
    return null
  }
}

async function writeCredentialsFile(data: CredentialsFile): Promise<void> {
  // SECURITY (R12): never persist demo credentials to disk in production.
  if (process.env.NODE_ENV === 'production' || process.env.VAULT_ENV === 'production') {
    console.warn('[vault][seed] refusing to write demo credentials file in production')
    return
  }
  await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Dynamic crypto loader
// ---------------------------------------------------------------------------

async function loadEncryptor(): Promise<EncryptorModule | null> {
  try {
    return await import('./crypto')
  } catch {
    return null
  }
}

interface EncryptedBlob {
  ciphertext: string
  encryptedDataKey: string
  kmsKeyRef: string
  cryptoScheme: string
}

async function encryptValueWithFallback(
  encryptor: EncryptorModule | null,
  plaintext: string,
  aad: { workspaceId: string; vaultSecretId: string; versionNumber: number },
): Promise<EncryptedBlob> {
  if (encryptor && typeof (encryptor as any).encryptValue === 'function') {
    try {
      const out = await (encryptor as any).encryptValue(plaintext, aad)
      if (
        out &&
        typeof out.ciphertext === 'string' &&
        typeof out.encryptedDataKey === 'string' &&
        typeof out.kmsKeyRef === 'string'
      ) {
        return {
          ciphertext: out.ciphertext,
          encryptedDataKey: out.encryptedDataKey,
          kmsKeyRef: out.kmsKeyRef,
          cryptoScheme:
            typeof out.cryptoScheme === 'string' ? out.cryptoScheme : CRYPTO_SCHEME,
        }
      }
    } catch (err) {
      // fall through to placeholder
      console.warn('[vault.seed] encryptValue failed, using placeholder:', err)
    }
  }
  return placeholder(plaintext)
}

function placeholder(plaintext: string): EncryptedBlob {
  return {
    ciphertext: PENDING_PREFIX + base64Encode(plaintext),
    encryptedDataKey: 'none',
    kmsKeyRef: KMS_KEY_REF,
    cryptoScheme: CRYPTO_SCHEME,
  }
}

function isPlaceholder(ciphertext: string): boolean {
  return typeof ciphertext === 'string' && ciphertext.startsWith(PENDING_PREFIX)
}

function plaintextFromPlaceholder(ciphertext: string): string {
  return base64Decode(ciphertext.slice(PENDING_PREFIX.length))
}

// ---------------------------------------------------------------------------
// Public: isSeeded()
// ---------------------------------------------------------------------------

export async function isSeeded(): Promise<boolean> {
  const ws = await db.workspace.findUnique({ where: { slug: 'production' } })
  return !!ws
}

// True iff the production workspace exists AND every SecretVersion in it is
// still a SEED_PENDING_ENCRYPTION placeholder (i.e. crypto wasn't ready when
// the first seed ran). In that state we want seed() to re-enter and upgrade
// in place rather than treat the system as fully seeded.
async function productionNeedsUpgrade(): Promise<boolean> {
  const prod = await db.workspace.findUnique({ where: { slug: 'production' } })
  if (!prod) return false
  const secrets = await db.vaultSecret.findMany({
    where: { workspaceId: prod.id },
    select: { id: true },
  })
  if (secrets.length === 0) return false
  const secretIds = secrets.map((s) => s.id)
  const totalVersions = await db.secretVersion.count({
    where: { vaultSecretId: { in: secretIds } },
  })
  if (totalVersions === 0) return false
  // Prisma's startsWith is supported on SQLite for String columns.
  const pending = await db.secretVersion.count({
    where: { vaultSecretId: { in: secretIds }, ciphertext: { startsWith: PENDING_PREFIX } },
  })
  return pending === totalVersions
}

// ---------------------------------------------------------------------------
// Public: upgradeSeedEncryption()
// Re-encrypts every SecretVersion that still carries the placeholder once the
// crypto module is importable. Returns the number of rows upgraded.
// ---------------------------------------------------------------------------

export async function upgradeSeedEncryption(): Promise<number> {
  const encryptor = await loadEncryptor()
  if (!encryptor) {
    // crypto not available yet — nothing to do.
    return 0
  }

  // Pull all placeholder versions, plus the secret/workspace ids for AAD.
  const pendingVersions = await db.secretVersion.findMany({
    where: { ciphertext: { startsWith: PENDING_PREFIX } },
    include: { vaultSecret: { select: { workspaceId: true, id: true } } },
  })

  if (pendingVersions.length === 0) return 0

  let upgraded = 0
  for (const v of pendingVersions) {
    if (!v.vaultSecret) continue
    const plaintext = plaintextFromPlaceholder(v.ciphertext)
    const aad = {
      workspaceId: v.vaultSecret.workspaceId,
      vaultSecretId: v.vaultSecretId,
      versionNumber: v.versionNumber,
    }
    const blob = await encryptValueWithFallback(encryptor, plaintext, aad)
    if (isPlaceholder(blob.ciphertext)) continue // still no crypto — skip
    await db.secretVersion.update({
      where: { id: v.id },
      data: {
        ciphertext: blob.ciphertext,
        encryptedDataKey: blob.encryptedDataKey,
        kmsKeyRef: blob.kmsKeyRef,
        cryptoScheme: blob.cryptoScheme,
      },
    })
    upgraded++
  }
  return upgraded
}

// ---------------------------------------------------------------------------
// Public: seed()
// ---------------------------------------------------------------------------

export async function seed(): Promise<SeedResult> {
  // Re-entry handling
  if (await isSeeded()) {
    if (await productionNeedsUpgrade()) {
      await upgradeSeedEncryption()
    }
    return {
      ok: true,
      created: await currentCounts(),
      credentials: (await readCredentialsFile())?.clients ?? {},
    }
  }

  // Fresh seed — do everything inside a transaction so we never leave a
  // half-built vault behind (and so the production workspace only appears
  // once everything is in place, which keeps isSeeded() honest).
  const credentials: Record<string, string> = {}
  const result = await db.$transaction(async (tx) => {
    const now = new Date()

    // --- Workspaces ---------------------------------------------------------
    const devWs = await tx.workspace.create({
      data: { slug: 'development', name: 'Dev Sandbox', status: 'active' },
    })
    const stagingWs = await tx.workspace.create({
      data: { slug: 'staging', name: 'Staging', status: 'active' },
    })
    const prodWs = await tx.workspace.create({
      data: { slug: 'production', name: 'Production', status: 'active' },
    })

    // --- Service clients (all in production) -------------------------------
    const clientSpecs: Array<{
      name: string
      clientType: 'bot' | 'gateway' | 'app' | 'cli' | 'mcp' | 'worker'
    }> = [
      { name: 'algo-scalper-bot', clientType: 'bot' },
      { name: 'nexum-gateway', clientType: 'gateway' },
      { name: 'web-backend', clientType: 'app' },
      { name: 'reporting-cli', clientType: 'cli' },
      { name: 'mcp-tools', clientType: 'mcp' },
    ]
    const clientIds: Record<string, string> = {}
    for (const spec of clientSpecs) {
      const publicId = `clt_${randomHex(4)}` // 8 hex chars
      const credential = `vlt_live_${randomHex(16)}` // 32 hex chars
      credentials[spec.name] = credential
      const credentialDigest = sha256Hex(credential)
      const credentialPrefix = credential.slice(0, 10)
      const client = await tx.serviceClient.create({
        data: {
          workspaceId: prodWs.id,
          publicId,
          name: spec.name,
          clientType: spec.clientType,
          credentialDigest,
          credentialPrefix,
          status: 'active',
        },
      })
      clientIds[spec.name] = client.id
    }

    // --- Secrets -----------------------------------------------------------
    // Plain values are computed up front; encryption happens per-version.
    interface SecretSpec {
      workspace: 'production' | 'staging'
      path: string
      name: string
      kind: string
      classification: string
      provider: string | null
      environment?: string
      value: string
      expiresAt: Date | null
    }

    const secretSpecs: SecretSpec[] = [
      {
        workspace: 'production',
        path: 'dhan/prod/access-token',
        name: 'Dhan API access token',
        kind: 'access_token',
        classification: 'confidential',
        provider: 'dhan',
        value: `DHAN_ACCESS_${randomHex(8)}`,
        expiresAt: minutesFromNow(90),
      },
      {
        workspace: 'production',
        path: 'dhan/prod/refresh-token',
        name: 'Dhan OAuth refresh token',
        kind: 'refresh_token',
        classification: 'restricted',
        provider: 'dhan',
        value: `DHAN_REFRESH_${randomHex(12)}`,
        expiresAt: daysFromNow(30),
      },
      {
        workspace: 'production',
        path: 'dhan/prod/totp-seed',
        name: 'Dhan 2FA TOTP seed',
        kind: 'totp_seed',
        classification: 'restricted',
        provider: 'dhan',
        value: 'JBSWY3DPEHPK3PXPABCDEFGH',
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'dhan/prod/client-id',
        name: 'Dhan OAuth client id',
        kind: 'api_key',
        classification: 'internal',
        provider: 'dhan',
        value: `DHAN_CLIENT_${randomAlnum(12)}`,
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'broker/prod/api-key',
        name: 'Broker live API key',
        kind: 'api_key',
        classification: 'confidential',
        provider: 'broker',
        value: `BRK_LIVE_${randomAlnum(20)}`,
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'broker/prod/api-secret',
        name: 'Broker API secret',
        kind: 'private_key',
        classification: 'restricted',
        provider: 'broker',
        value: `brk_secret_${randomAlnum(24)}`,
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'oauth/github/client-id',
        name: 'GitHub OAuth client id',
        kind: 'api_key',
        classification: 'internal',
        provider: 'github',
        value: `gh_client_${randomAlnum(12)}`,
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'oauth/github/client-secret',
        name: 'GitHub OAuth client secret',
        kind: 'client_secret',
        classification: 'restricted',
        provider: 'github',
        value: `gh_secret_${randomAlnum(32)}`,
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'oauth/github/access-token',
        name: 'GitHub OAuth access token',
        kind: 'access_token',
        classification: 'confidential',
        provider: 'github',
        value: `gho_${randomAlnum(24)}`,
        expiresAt: minutesFromNow(30),
      },
      {
        workspace: 'production',
        path: 'oauth/github/refresh-token',
        name: 'GitHub OAuth refresh token',
        kind: 'refresh_token',
        classification: 'restricted',
        provider: 'github',
        value: `ghr_${randomAlnum(24)}`,
        expiresAt: daysFromNow(30),
      },
      {
        workspace: 'production',
        path: 'db/prod/connection-string',
        name: 'Production DB connection string',
        kind: 'connection_string',
        classification: 'restricted',
        provider: null,
        value: 'postgresql://vault:***@db.internal:5432/vault',
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'signing/prod/private-key',
        name: 'Signing private key',
        kind: 'private_key',
        classification: 'restricted',
        provider: null,
        value: '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9...\n-----END PRIVATE KEY-----',
        expiresAt: null,
      },
      {
        workspace: 'production',
        path: 'web/prod/stripe-secret',
        name: 'Stripe live secret key',
        kind: 'api_key',
        classification: 'restricted',
        provider: 'stripe',
        value: `sk_live_${randomAlnum(24)}`,
        expiresAt: null,
      },
      {
        workspace: 'staging',
        path: 'staging/dhan/access-token',
        name: 'Dhan staging access token',
        kind: 'access_token',
        classification: 'confidential',
        provider: 'dhan',
        environment: 'staging',
        value: `DHAN_STAGING_ACCESS_${randomHex(8)}`,
        expiresAt: minutesFromNow(120),
      },
      {
        workspace: 'staging',
        path: 'staging/dhan/refresh-token',
        name: 'Dhan staging refresh token',
        kind: 'refresh_token',
        classification: 'restricted',
        provider: 'dhan',
        environment: 'staging',
        value: `DHAN_STAGING_REFRESH_${randomHex(12)}`,
        expiresAt: daysFromNow(30),
      },
    ]

    // Best-effort crypto import — created in parallel by task 2-b. If it is
    // not yet present, every version gets a placeholder ciphertext. The
    // upgradeSeedEncryption() pass will swap them out once crypto is online.
    const encryptor = await loadEncryptor()

    const secretIds: Record<string, string> = {}
    const versionIds: Record<string, string> = {} // secret path -> version id

    for (const spec of secretSpecs) {
      const ws = spec.workspace === 'staging' ? stagingWs : prodWs
      const secret = await tx.vaultSecret.create({
        data: {
          workspaceId: ws.id,
          path: spec.path,
          name: spec.name,
          kind: spec.kind,
          classification: spec.classification,
          environment: spec.environment ?? 'production',
          provider: spec.provider,
          status: 'active',
          expiresAt: spec.expiresAt,
        },
      })
      secretIds[spec.path] = secret.id

      const blob = await encryptValueWithFallback(encryptor, spec.value, {
        workspaceId: ws.id,
        vaultSecretId: secret.id,
        versionNumber: 1,
      })

      const version = await tx.secretVersion.create({
        data: {
          vaultSecretId: secret.id,
          versionNumber: 1,
          ciphertext: blob.ciphertext,
          encryptedDataKey: blob.encryptedDataKey,
          kmsKeyRef: blob.kmsKeyRef,
          cryptoScheme: blob.cryptoScheme,
          status: 'active',
          createdBy: 'system',
          activatedAt: now,
        },
      })
      versionIds[spec.path] = version.id

      await tx.vaultSecret.update({
        where: { id: secret.id },
        data: { currentVersionId: version.id },
      })
    }

    // --- Integration connections ------------------------------------------
    interface ConnectionSpec {
      key: string
      workspaceId: string
      providerKey: string
      authMethod: string
      adapterKey: string
      providerAccountRef: string | null
      status: string
      accessExpiresAt: Date | null
      refreshAfter: Date | null
      lastErrorCode?: string | null
      reauthRequiredAt?: Date | null
      bindings: Array<{ purpose: string; secretPath: string }>
    }

    const connectionSpecs: ConnectionSpec[] = [
      {
        key: 'dhan-prod',
        workspaceId: prodWs.id,
        providerKey: 'dhan',
        authMethod: 'oauth2_refresh',
        adapterKey: 'dhan_v1',
        providerAccountRef: 'DHAN_ACCT_001',
        status: 'active',
        accessExpiresAt: minutesFromNow(90),
        refreshAfter: minutesFromNow(2),
        bindings: [
          { purpose: 'access_token', secretPath: 'dhan/prod/access-token' },
          { purpose: 'refresh_token', secretPath: 'dhan/prod/refresh-token' },
          { purpose: 'client_id', secretPath: 'dhan/prod/client-id' },
        ],
      },
      {
        key: 'dhan-staging',
        workspaceId: stagingWs.id,
        providerKey: 'dhan',
        authMethod: 'oauth2_refresh',
        adapterKey: 'dhan_v1',
        providerAccountRef: 'DHAN_ACCT_STAGING',
        status: 'active',
        accessExpiresAt: minutesFromNow(120),
        refreshAfter: minutesFromNow(30),
        bindings: [
          { purpose: 'access_token', secretPath: 'staging/dhan/access-token' },
          { purpose: 'refresh_token', secretPath: 'staging/dhan/refresh-token' },
        ],
      },
      {
        key: 'broker-prod',
        workspaceId: prodWs.id,
        providerKey: 'broker',
        authMethod: 'api_key',
        adapterKey: 'api_key_static',
        providerAccountRef: 'BRK_001',
        status: 'active',
        accessExpiresAt: null,
        refreshAfter: null,
        bindings: [{ purpose: 'api_key', secretPath: 'broker/prod/api-key' }],
      },
      {
        key: 'github-oauth',
        workspaceId: prodWs.id,
        providerKey: 'oauth-generic',
        authMethod: 'oauth2_refresh',
        adapterKey: 'oauth2_generic',
        providerAccountRef: 'gh-user-42',
        status: 'active',
        accessExpiresAt: minutesFromNow(30),
        refreshAfter: minutesFromNow(1.5), // 90 seconds
        bindings: [
          { purpose: 'access_token', secretPath: 'oauth/github/access-token' },
          { purpose: 'refresh_token', secretPath: 'oauth/github/refresh-token' },
          { purpose: 'client_id', secretPath: 'oauth/github/client-id' },
          { purpose: 'client_secret', secretPath: 'oauth/github/client-secret' },
        ],
      },
      {
        key: 'stuck-connection',
        workspaceId: prodWs.id,
        providerKey: 'dhan',
        authMethod: 'oauth2_refresh',
        adapterKey: 'dhan_v1',
        providerAccountRef: 'DHAN_ACCT_007',
        status: 'reauth_required',
        accessExpiresAt: null,
        refreshAfter: null,
        lastErrorCode: 'invalid_grant',
        reauthRequiredAt: now,
        bindings: [
          { purpose: 'access_token', secretPath: 'dhan/prod/access-token' },
          { purpose: 'refresh_token', secretPath: 'dhan/prod/refresh-token' },
        ],
      },
    ]

    const connectionIds: Record<string, string> = {}
    for (const spec of connectionSpecs) {
      const conn = await tx.integrationConnection.create({
        data: {
          workspaceId: spec.workspaceId,
          providerKey: spec.providerKey,
          authMethod: spec.authMethod,
          adapterKey: spec.adapterKey,
          providerAccountRef: spec.providerAccountRef,
          status: spec.status,
          accessExpiresAt: spec.accessExpiresAt,
          refreshAfter: spec.refreshAfter,
          lastErrorCode: spec.lastErrorCode ?? null,
          reauthRequiredAt: spec.reauthRequiredAt ?? null,
          refreshGeneration: 0,
        },
      })
      connectionIds[spec.key] = conn.id

      for (const b of spec.bindings) {
        const sid = secretIds[b.secretPath]
        if (!sid) continue
        await tx.connectionSecretBinding.create({
          data: {
            connectionId: conn.id,
            vaultSecretId: sid,
            purpose: b.purpose,
          },
        })
      }
    }

    // --- Grants (least privilege) -----------------------------------------
    interface GrantSpec {
      clientName: string
      secretPath: string
      permissions: string[] // comma-separated on save
    }
    const grantSpecs: GrantSpec[] = [
      { clientName: 'algo-scalper-bot', secretPath: 'dhan/prod/access-token', permissions: ['value:read'] },
      { clientName: 'algo-scalper-bot', secretPath: 'dhan/prod/client-id', permissions: ['metadata:read'] },
      {
        clientName: 'nexum-gateway',
        secretPath: 'dhan/prod/access-token',
        permissions: ['value:read', 'connection:refresh'],
      },
      { clientName: 'nexum-gateway', secretPath: 'broker/prod/api-key', permissions: ['value:read'] },
      { clientName: 'nexum-gateway', secretPath: 'web/prod/stripe-secret', permissions: ['value:read'] },
      { clientName: 'web-backend', secretPath: 'db/prod/connection-string', permissions: ['value:read'] },
      { clientName: 'web-backend', secretPath: 'web/prod/stripe-secret', permissions: ['value:read'] },
      { clientName: 'web-backend', secretPath: 'oauth/github/access-token', permissions: ['value:read'] },
      { clientName: 'reporting-cli', secretPath: 'dhan/prod/access-token', permissions: ['metadata:read'] },
      { clientName: 'reporting-cli', secretPath: 'broker/prod/api-key', permissions: ['metadata:read'] },
      { clientName: 'reporting-cli', secretPath: 'web/prod/stripe-secret', permissions: ['metadata:read'] },
      { clientName: 'mcp-tools', secretPath: 'dhan/prod/access-token', permissions: ['value:read'] },
    ]
    for (const g of grantSpecs) {
      const cid = clientIds[g.clientName]
      const sid = secretIds[g.secretPath]
      if (!cid || !sid) continue
      await tx.secretAccessGrant.create({
        data: {
          serviceClientId: cid,
          vaultSecretId: sid,
          permissions: g.permissions.join(','),
        },
      })
    }

    // --- Historical RotationRuns ------------------------------------------
    interface RunSpec {
      connectionKey: string | null
      secretPath: string | null
      operation: string
      status: string
      attemptCount: number
      startedAt: Date
      completedAt: Date | null
      runAfter?: Date
      errorCode?: string | null
      correlationId?: string
      resultVersionPath?: string | null
    }
    const runSpecs: RunSpec[] = [
      {
        connectionKey: 'dhan-prod',
        secretPath: null,
        operation: 'refresh',
        status: 'succeeded',
        attemptCount: 1,
        startedAt: hoursAgo(2),
        completedAt: new Date(hoursAgo(2).getTime() + 5_000),
        resultVersionPath: 'dhan/prod/access-token',
      },
      {
        connectionKey: 'dhan-prod',
        secretPath: null,
        operation: 'refresh',
        status: 'failed',
        attemptCount: 2,
        startedAt: hoursAgo(3),
        completedAt: new Date(hoursAgo(3).getTime() + 6_000),
        errorCode: 'transient',
      },
      {
        connectionKey: 'dhan-prod',
        secretPath: null,
        operation: 'rotate',
        status: 'succeeded',
        attemptCount: 1,
        startedAt: daysAgo(1),
        completedAt: new Date(daysAgo(1).getTime() + 12_000),
        resultVersionPath: 'dhan/prod/refresh-token',
      },
      {
        connectionKey: 'github-oauth',
        secretPath: null,
        operation: 'refresh',
        status: 'succeeded',
        attemptCount: 1,
        startedAt: hoursAgo(1),
        completedAt: new Date(hoursAgo(1).getTime() + 3_000),
        resultVersionPath: 'oauth/github/access-token',
      },
      {
        connectionKey: 'github-oauth',
        secretPath: null,
        operation: 'refresh',
        status: 'cancelled',
        attemptCount: 1,
        startedAt: minutesAgo(30),
        completedAt: new Date(minutesAgo(30).getTime() + 1_000),
        errorCode: 'stale_generation',
      },
      {
        connectionKey: 'dhan-staging',
        secretPath: null,
        operation: 'refresh',
        status: 'succeeded',
        attemptCount: 1,
        startedAt: hoursAgo(4),
        completedAt: new Date(hoursAgo(4).getTime() + 4_000),
        resultVersionPath: 'staging/dhan/access-token',
      },
      {
        connectionKey: null,
        secretPath: 'web/prod/stripe-secret',
        operation: 'rotate',
        status: 'succeeded',
        attemptCount: 1,
        startedAt: daysAgo(2),
        completedAt: new Date(daysAgo(2).getTime() + 9_000),
        resultVersionPath: 'web/prod/stripe-secret',
      },
      {
        connectionKey: 'stuck-connection',
        secretPath: null,
        operation: 'reauthorize',
        status: 'failed',
        attemptCount: 1,
        startedAt: minutesAgo(45),
        completedAt: new Date(minutesAgo(45).getTime() + 2_000),
        errorCode: 'invalid_grant',
      },
    ]

    for (const r of runSpecs) {
      await tx.rotationRun.create({
        data: {
          connectionId: r.connectionKey ? connectionIds[r.connectionKey] ?? null : null,
          vaultSecretId: r.secretPath ? secretIds[r.secretPath] ?? null : null,
          operation: r.operation,
          status: r.status,
          attemptCount: r.attemptCount,
          idempotencyKey: uuid(),
          runAfter: r.runAfter ?? r.startedAt,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          resultVersionId:
            r.resultVersionPath && secretIds[r.resultVersionPath]
              ? versionIds[r.resultVersionPath]!
              : null,
          errorCode: r.errorCode ?? null,
          correlationId: r.correlationId ?? uuid(),
        },
      })
    }

    // --- Audit events (metadata only — NO secret values) ------------------
    interface EventSpec {
      workspace: 'production' | 'staging'
      actorClient: string | null // client name or null (admin/system)
      secretPath: string | null
      action: string
      outcome: 'success' | 'denied' | 'error'
      reasonCode?: string | null
      createdAt: Date
      sourceIp?: string
    }
    const eventSpecs: EventSpec[] = [
      {
        workspace: 'production',
        actorClient: null,
        secretPath: 'dhan/prod/access-token',
        action: 'secret.create',
        outcome: 'success',
        createdAt: hoursAgo(23),
        sourceIp: '10.0.0.1',
      },
      {
        workspace: 'production',
        actorClient: 'algo-scalper-bot',
        secretPath: 'dhan/prod/access-token',
        action: 'secret.reveal',
        outcome: 'success',
        createdAt: hoursAgo(22),
        sourceIp: '10.0.0.7',
      },
      {
        workspace: 'production',
        actorClient: 'reporting-cli',
        secretPath: 'dhan/prod/access-token',
        action: 'secret.reveal',
        outcome: 'denied',
        reasonCode: 'grant_required',
        createdAt: hoursAgo(21),
        sourceIp: '10.0.0.12',
      },
      {
        workspace: 'production',
        actorClient: null,
        secretPath: 'oauth/github/access-token',
        action: 'secret.rotate',
        outcome: 'success',
        createdAt: hoursAgo(20),
        sourceIp: '10.0.0.1',
      },
      {
        workspace: 'production',
        actorClient: null,
        secretPath: null,
        action: 'client.create',
        outcome: 'success',
        createdAt: hoursAgo(19),
        sourceIp: '10.0.0.1',
      },
      {
        workspace: 'production',
        actorClient: 'mcp-tools',
        secretPath: 'broker/prod/api-key',
        action: 'grant.deny',
        outcome: 'denied',
        reasonCode: 'validation_failed',
        createdAt: hoursAgo(18),
        sourceIp: '10.0.0.19',
      },
      {
        workspace: 'production',
        actorClient: null,
        secretPath: null,
        action: 'refresh.succeeded',
        outcome: 'success',
        createdAt: hoursAgo(15),
        sourceIp: '10.0.0.2',
      },
      {
        workspace: 'production',
        actorClient: null,
        secretPath: null,
        action: 'refresh.failed',
        outcome: 'error',
        reasonCode: 'invalid_grant',
        createdAt: hoursAgo(12),
        sourceIp: '10.0.0.2',
      },
      {
        workspace: 'production',
        actorClient: 'nexum-gateway',
        secretPath: 'dhan/prod/access-token',
        action: 'connection.credential',
        outcome: 'success',
        createdAt: hoursAgo(8),
        sourceIp: '10.0.0.21',
      },
      {
        workspace: 'production',
        actorClient: 'nexum-gateway',
        secretPath: 'broker/prod/api-key',
        action: 'secret.reveal',
        outcome: 'success',
        createdAt: hoursAgo(6),
        sourceIp: '10.0.0.21',
      },
      {
        workspace: 'production',
        actorClient: null,
        secretPath: 'web/prod/stripe-secret',
        action: 'secret.create',
        outcome: 'success',
        createdAt: hoursAgo(3),
        sourceIp: '10.0.0.1',
      },
      {
        workspace: 'production',
        actorClient: 'web-backend',
        secretPath: 'oauth/github/access-token',
        action: 'connection.credential',
        outcome: 'error',
        reasonCode: 'credential_refresh_unavailable',
        createdAt: minutesAgo(30),
        sourceIp: '10.0.0.30',
      },
    ]

    for (const e of eventSpecs) {
      const wsId = e.workspace === 'staging' ? stagingWs.id : prodWs.id
      const cid = e.actorClient ? clientIds[e.actorClient] ?? null : null
      const sid = e.secretPath ? secretIds[e.secretPath] ?? null : null
      await tx.secretAccessEvent.create({
        data: {
          workspaceId: wsId,
          actorClientId: cid,
          vaultSecretId: sid,
          secretVersionId: null,
          action: e.action,
          outcome: e.outcome,
          reasonCode: e.reasonCode ?? null,
          requestId: uuid(),
          sourceIp: e.sourceIp ?? `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
          createdAt: e.createdAt,
        },
      })
    }

    // --- Counts to return --------------------------------------------------
    return {
      workspaces: 3,
      serviceClients: 5,
      secrets: 15,
      secretVersions: 15,
      connections: 5,
      bindings: 12,
      grants: 12,
      rotationRuns: 8,
      auditEvents: 12,
    }
  })

  // Persist the full credentials map (admin token + per-client credentials).
  await writeCredentialsFile({
    admin: process.env.VAULT_ADMIN_TOKEN || ADMIN_TOKEN_DEFAULT,
    clients: credentials,
  })

  return { ok: true, created: result, credentials }
}

// ---------------------------------------------------------------------------
// Count helper (for re-entries)
// ---------------------------------------------------------------------------

async function currentCounts(): Promise<Record<string, number>> {
  const [
    workspaces,
    serviceClients,
    secrets,
    secretVersions,
    connections,
    bindings,
    grants,
    rotationRuns,
    auditEvents,
  ] = await Promise.all([
    db.workspace.count(),
    db.serviceClient.count(),
    db.vaultSecret.count(),
    db.secretVersion.count(),
    db.integrationConnection.count(),
    db.connectionSecretBinding.count(),
    db.secretAccessGrant.count(),
    db.rotationRun.count(),
    db.secretAccessEvent.count(),
  ])
  return {
    workspaces,
    serviceClients,
    secrets,
    secretVersions,
    connections,
    bindings,
    grants,
    rotationRuns,
    auditEvents,
  }
}
