// /api/v1/secrets — admin + client realms.
// GET  → 200 { secrets: SecretListItem[] }
//        admin: all secrets in the requested workspace (or all workspaces if no param)
//        client: only secrets in their workspace that have any grant for that client
// POST → 201 { secret, version }       (admin only)
import { handle, json, body, adminOrThrow, getRequestId, getSourceIp, actor } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { encryptValue } from '@/lib/vault/crypto'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'
import type { Permission, SecretKind, Classification } from '@/lib/vault/types'

const SECRET_KINDS = new Set([
  'api_key', 'access_token', 'refresh_token', 'client_secret',
  'totp_seed', 'private_key', 'certificate', 'connection_string', 'public_key',
])
const CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted'])

function serializeSecret(s: {
  id: string
  workspaceId: string
  path: string
  name: string
  kind: string
  classification: string
  environment: string
  provider: string | null
  status: string
  expiresAt: Date | null
  currentVersionId: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    path: s.path,
    name: s.name,
    kind: s.kind,
    classification: s.classification,
    environment: s.environment,
    provider: s.provider,
    status: s.status,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    currentVersionId: s.currentVersionId,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

function serializeVersion(v: {
  id: string
  vaultSecretId: string
  versionNumber: number
  status: string
  cryptoScheme: string
  kmsKeyRef: string
  createdBy: string
  activatedAt: Date
  retiredAt: Date | null
  createdAt: Date
}) {
  return {
    id: v.id,
    vaultSecretId: v.vaultSecretId,
    versionNumber: v.versionNumber,
    status: v.status,
    cryptoScheme: v.cryptoScheme,
    kmsKeyRef: v.kmsKeyRef,
    createdBy: v.createdBy,
    activatedAt: v.activatedAt.toISOString(),
    retiredAt: v.retiredAt ? v.retiredAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
  }
}

export const GET = handle(async (req) => {
  const auth = await actor(req)
  const requestedWs = new URL(req.url).searchParams.get('workspaceId') || undefined

  if (auth.kind === 'none') throw new VaultError('unauthorized')

  if (auth.kind === 'admin') {
    const where = requestedWs ? { workspaceId: requestedWs } : {}
    const rows = await db.vaultSecret.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { versions: true } } },
    })
    // Resolve currentVersionNumber per secret (single query against versions).
    const ids = rows.map((r) => r.id)
    const currentVersions = await db.secretVersion.findMany({
      where: { vaultSecretId: { in: ids }, status: 'active' },
      select: { vaultSecretId: true, versionNumber: true },
    })
    const verBySecret = new Map(currentVersions.map((v) => [v.vaultSecretId, v.versionNumber]))

    const secrets = rows.map((s) => ({
      ...serializeSecret(s),
      currentVersionNumber: verBySecret.get(s.id) ?? null,
      versionCount: s._count.versions,
    }))
    return json({ secrets })
  }

  // client realm — scoped to client.workspaceId, only granted secrets.
  const clientId = auth.client.id
  const grants = await db.secretAccessGrant.findMany({
    where: { serviceClientId: clientId },
    select: { vaultSecretId: true },
  })
  const grantedIds = Array.from(new Set(grants.map((g) => g.vaultSecretId)))
  if (grantedIds.length === 0) return json({ secrets: [] })

  const rows = await db.vaultSecret.findMany({
    where: {
      id: { in: grantedIds },
      workspaceId: auth.client.workspaceId,
    },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { versions: true } } },
  })
  const currentVersions = await db.secretVersion.findMany({
    where: { vaultSecretId: { in: grantedIds }, status: 'active' },
    select: { vaultSecretId: true, versionNumber: true },
  })
  const verBySecret = new Map(currentVersions.map((v) => [v.vaultSecretId, v.versionNumber]))

  const secrets = rows.map((s) => ({
    ...serializeSecret(s),
    currentVersionNumber: verBySecret.get(s.id) ?? null,
    versionCount: s._count.versions,
  }))
  return json({ secrets })
})

export const POST = handle(async (req) => {
  await adminOrThrow(req)
  const input = await body<{
    workspaceId?: string
    path?: string
    name?: string
    kind?: string
    classification?: string
    environment?: string
    provider?: string
    value?: string
    expiresInHours?: number
    createdByClientId?: string
  }>(req)

  const workspaceId = (input.workspaceId || '').trim()
  const path = (input.path || '').trim()
  const name = (input.name || '').trim()
  const kind = (input.kind || '').trim()
  const value = input.value ?? ''
  assert(workspaceId && path && name && kind, 'validation_failed', 'workspaceId, path, name, kind are required')
  assert(value && typeof value === 'string', 'validation_failed', 'value is required (non-empty string)')
  assert(SECRET_KINDS.has(kind), 'validation_failed', `kind must be one of: ${Array.from(SECRET_KINDS).join(', ')}`)
  const classification = input.classification && CLASSIFICATIONS.has(input.classification)
    ? input.classification
    : 'confidential'
  const environment = (input.environment || 'production').trim() || 'production'
  const provider = input.provider?.trim() || null
  const createdBy = (input.createdByClientId || 'admin').trim()

  const ws = await db.workspace.findUnique({ where: { id: workspaceId } })
  if (!ws) throw new VaultError('workspace_not_found')

  const dup = await db.vaultSecret.findUnique({ where: { workspaceId_path: { workspaceId, path } } })
  if (dup) throw new VaultError('conflict', 'path already exists in this workspace')

  const now = new Date()
  const expiresAt =
    typeof input.expiresInHours === 'number' && input.expiresInHours > 0
      ? new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1000)
      : null

  // Create secret + first version atomically.
  const secret = await db.$transaction(async (tx) => {
    const created = await tx.vaultSecret.create({
      data: {
        workspaceId,
        path,
        name,
        kind,
        classification,
        environment,
        provider,
        status: 'active',
        expiresAt,
      },
    })

    const aad = { workspaceId, vaultSecretId: created.id, versionNumber: 1 }
    const enc = await encryptValue(value, aad)

    const version = await tx.secretVersion.create({
      data: {
        vaultSecretId: created.id,
        versionNumber: 1,
        ciphertext: enc.ciphertext,
        encryptedDataKey: enc.encryptedDataKey,
        kmsKeyRef: enc.kmsKeyRef,
        cryptoScheme: enc.cryptoScheme,
        status: 'active',
        createdBy,
        activatedAt: now,
      },
    })

    const updated = await tx.vaultSecret.update({
      where: { id: created.id },
      data: { currentVersionId: version.id, updatedAt: now },
    })
    return { secret: updated, version }
  })

  await recordEventCritical({
    workspaceId,
    vaultSecretId: secret.secret.id,
    secretVersionId: secret.version.id,
    action: 'secret.create',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json(
    {
      secret: serializeSecret(secret.secret),
      version: serializeVersion(secret.version),
    },
    201,
  )
})
