// POST /api/v1/admin/grants → 201 { grant }
// body { serviceClientId, vaultSecretId, permissions }
// `permissions` is a comma-separated string of valid perms. Upsert on
// the (serviceClientId, vaultSecretId) unique pair.
import { handle, json, body, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { parsePermissions, serializePermissions } from '@/lib/vault/authorization'
import { ALL_PERMISSIONS, type Permission } from '@/lib/vault/types'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'

export const POST = handle(async (req) => {
  await adminOrThrow(req)
  const input = await body<{
    serviceClientId?: string
    vaultSecretId?: string
    permissions?: string
  }>(req)

  const serviceClientId = (input.serviceClientId || '').trim()
  const vaultSecretId = (input.vaultSecretId || '').trim()
  const permsRaw = (input.permissions || '').trim()
  assert(serviceClientId && vaultSecretId, 'validation_failed', 'serviceClientId and vaultSecretId are required')

  // Validate that every permission token is a known one.
  const permsList = parsePermissions(permsRaw)
  // Reject unknown tokens (parsePermissions drops them silently — we want a hard fail).
  const requestedTokens = permsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  for (const tok of requestedTokens) {
    if (!(ALL_PERMISSIONS as string[]).includes(tok)) {
      throw new VaultError('validation_failed', `Unknown permission: ${tok}`)
    }
  }
  // Disallow empty perm set — a grant with no permissions is meaningless.
  assert(permsList.length > 0, 'validation_failed', 'permissions must be a non-empty comma-separated list of valid values')
  const permissions = serializePermissions(permsList as Permission[])

  // Ensure the client + secret exist (and share the same workspace — defense in depth).
  const client = await db.serviceClient.findUnique({ where: { id: serviceClientId } })
  if (!client) throw new VaultError('client_not_found')
  const secret = await db.vaultSecret.findUnique({ where: { id: vaultSecretId } })
  if (!secret) throw new VaultError('secret_not_found')
  if (client.workspaceId !== secret.workspaceId) {
    throw new VaultError('validation_failed', 'client and secret must belong to the same workspace')
  }

  const grant = await db.secretAccessGrant.upsert({
    where: { serviceClientId_vaultSecretId: { serviceClientId, vaultSecretId } },
    create: { serviceClientId, vaultSecretId, permissions },
    update: { permissions, updatedAt: new Date() },
  })

  await recordEventCritical({
    workspaceId: client.workspaceId,
    actorClientId: client.id,
    vaultSecretId,
    action: 'grant.create',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json(
    {
      grant: {
        id: grant.id,
        serviceClientId: grant.serviceClientId,
        vaultSecretId: grant.vaultSecretId,
        permissions: grant.permissions,
        createdAt: grant.createdAt.toISOString(),
        updatedAt: grant.updatedAt.toISOString(),
      },
    },
    201,
  )
})
