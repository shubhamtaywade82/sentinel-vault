// GET /api/v1/secrets/[id] → 200 { secret: SecretDetail }
// admin OR client with any grant on this secret (else `secret_access_denied`).
import { handle, json, actor } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { checkGrant } from '@/lib/vault/authorization'
import type { Permission } from '@/lib/vault/types'

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

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const secret = await db.vaultSecret.findUnique({ where: { id } })
  if (!secret) throw new VaultError('secret_not_found')

  if (auth.kind === 'client') {
    // Must be in the client's workspace and have any grant on this secret.
    if (auth.client.workspaceId !== secret.workspaceId) {
      throw new VaultError('secret_access_denied')
    }
    // Any of the seven permissions counts as "has a grant".
    const anyGrant: Permission | null = await hasAnyGrant(auth.client.id, id)
    if (!anyGrant) throw new VaultError('secret_access_denied')
  }

  const versions = await db.secretVersion.findMany({
    where: { vaultSecretId: id },
    orderBy: { versionNumber: 'desc' },
  })

  return json({
    secret: { ...serializeSecret(secret), versions: versions.map(serializeVersion) },
  })
})

async function hasAnyGrant(serviceClientId: string, vaultSecretId: string): Promise<Permission | null> {
  const perms: Permission[] = [
    'metadata:read', 'value:read', 'version:create', 'rotate', 'revoke',
    'connection:refresh', 'audit:read',
  ]
  for (const p of perms) {
    if (await checkGrant(serviceClientId, vaultSecretId, p)) return p
  }
  return null
}
