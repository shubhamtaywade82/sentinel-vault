// /api/v1/connections — admin + client realms.
// GET  → 200 { connections: ConnectionListItem[] }
//        admin: all in requested workspace (or all).
//        client: connections in their workspace whose bound secrets have at
//                least one `value:read` OR `connection:refresh` grant for them.
// POST → 201 { connection }   (admin only)  body { workspaceId, providerKey,
//        authMethod, adapterKey, providerAccountRef?, accessExpiresAt?,
//        refreshAfter?, bindings:[{ purpose, secretId }] }
import { handle, json, body, adminOrThrow, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { getAdapter } from '@/lib/vault/providers'
import { checkGrant } from '@/lib/vault/authorization'
import { recordEvent } from '@/lib/vault/audit'

function serializeConnection(c: {
  id: string
  workspaceId: string
  providerKey: string
  authMethod: string
  adapterKey: string
  providerAccountRef: string | null
  status: string
  accessExpiresAt: Date | null
  refreshAfter: Date | null
  lastRefreshedAt: Date | null
  refreshLeaseExpiresAt: Date | null
  refreshGeneration: number
  lastErrorCode: string | null
  reauthRequiredAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    providerKey: c.providerKey,
    authMethod: c.authMethod,
    adapterKey: c.adapterKey,
    providerAccountRef: c.providerAccountRef,
    status: c.status,
    accessExpiresAt: c.accessExpiresAt ? c.accessExpiresAt.toISOString() : null,
    refreshAfter: c.refreshAfter ? c.refreshAfter.toISOString() : null,
    lastRefreshedAt: c.lastRefreshedAt ? c.lastRefreshedAt.toISOString() : null,
    refreshLeaseExpiresAt: c.refreshLeaseExpiresAt ? c.refreshLeaseExpiresAt.toISOString() : null,
    refreshGeneration: c.refreshGeneration,
    lastErrorCode: c.lastErrorCode,
    reauthRequiredAt: c.reauthRequiredAt ? c.reauthRequiredAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

async function serializeBindings(
  bindingRows: { id: string; connectionId: string; vaultSecretId: string; purpose: string }[],
) {
  const secretIds = Array.from(new Set(bindingRows.map((b) => b.vaultSecretId)))
  if (secretIds.length === 0) return []
  const secrets = await db.vaultSecret.findMany({
    where: { id: { in: secretIds } },
    select: { id: true, path: true, name: true },
  })
  const byId = new Map(secrets.map((s) => [s.id, s]))
  return bindingRows.map((b) => ({
    id: b.id,
    connectionId: b.connectionId,
    vaultSecretId: b.vaultSecretId,
    purpose: b.purpose,
    secretPath: byId.get(b.vaultSecretId)?.path,
    secretName: byId.get(b.vaultSecretId)?.name,
  }))
}

async function loadBindings(connectionId: string) {
  const rows = await db.connectionSecretBinding.findMany({ where: { connectionId } })
  return serializeBindings(rows)
}

export const GET = handle(async (req) => {
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')
  const requestedWs = new URL(req.url).searchParams.get('workspaceId') || undefined

  if (auth.kind === 'admin') {
    const where = requestedWs ? { workspaceId: requestedWs } : {}
    const conns = await db.integrationConnection.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    const out = []
    for (const c of conns) {
      out.push({ ...serializeConnection(c), bindings: await loadBindings(c.id) })
    }
    return json({ connections: out })
  }

  // client realm: scoped to client workspace, only connections with at least
  // one granted binding (value:read OR connection:refresh).
  const clientId = auth.client.id
  const wsId = auth.client.workspaceId

  const conns = await db.integrationConnection.findMany({
    where: { workspaceId: wsId },
    orderBy: { createdAt: 'desc' },
  })
  const out = []
  for (const c of conns) {
    const bindingRows = await db.connectionSecretBinding.findMany({ where: { connectionId: c.id } })
    const serialized = await serializeBindings(bindingRows)
    // Visibility check.
    let visible = false
    for (const b of bindingRows) {
      const vr = await checkGrant(clientId, b.vaultSecretId, 'value:read')
      const cr = await checkGrant(clientId, b.vaultSecretId, 'connection:refresh')
      if (vr || cr) {
        visible = true
        break
      }
    }
    if (visible) {
      out.push({ ...serializeConnection(c), bindings: serialized })
    }
  }
  return json({ connections: out })
})

export const POST = handle(async (req) => {
  await adminOrThrow(req)
  const input = await body<{
    workspaceId?: string
    providerKey?: string
    authMethod?: string
    adapterKey?: string
    providerAccountRef?: string
    accessExpiresAt?: string
    refreshAfter?: string
    bindings?: { purpose: string; secretId: string }[]
  }>(req)

  const workspaceId = (input.workspaceId || '').trim()
  const providerKey = (input.providerKey || '').trim()
  const authMethod = (input.authMethod || '').trim()
  const adapterKey = (input.adapterKey || '').trim()
  const providerAccountRef = input.providerAccountRef?.trim() || null
  assert(workspaceId && providerKey && authMethod && adapterKey, 'validation_failed', 'workspaceId, providerKey, authMethod, adapterKey are required')

  // Validate adapter key is registered.
  assert(() => {
    try {
      getAdapter(adapterKey)
      return true
    } catch {
      return false
    }
  }, 'validation_failed', `Unknown adapterKey: ${adapterKey}`)

  // Validate workspace exists.
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } })
  if (!ws) throw new VaultError('workspace_not_found')

  // Validate bindings.
  const bindings = Array.isArray(input.bindings) ? input.bindings : []
  if (bindings.length === 0) {
    throw new VaultError('validation_failed', 'at least one binding is required')
  }
  // Validate every secretId belongs to the workspace.
  const secretIds = Array.from(new Set(bindings.map((b) => b.secretId)))
  const secrets = await db.vaultSecret.findMany({ where: { id: { in: secretIds }, workspaceId } })
  if (secrets.length !== secretIds.length) {
    throw new VaultError('validation_failed', 'all binding secrets must belong to the requested workspace')
  }
  // Check duplicate purposes within the request.
  const purposes = bindings.map((b) => b.purpose.trim())
  if (new Set(purposes).size !== purposes.length) {
    throw new VaultError('validation_failed', 'duplicate purposes in bindings')
  }
  for (const p of purposes) {
    assert(p, 'validation_failed', 'each binding needs a purpose')
  }

  const accessExpiresAt = input.accessExpiresAt ? new Date(input.accessExpiresAt) : null
  const refreshAfter = input.refreshAfter ? new Date(input.refreshAfter) : null
  if (input.accessExpiresAt && Number.isNaN(accessExpiresAt!.getTime())) {
    throw new VaultError('validation_failed', 'accessExpiresAt is not a valid ISO date')
  }
  if (input.refreshAfter && Number.isNaN(refreshAfter!.getTime())) {
    throw new VaultError('validation_failed', 'refreshAfter is not a valid ISO date')
  }

  const connection = await db.$transaction(async (tx) => {
    const conn = await tx.integrationConnection.create({
      data: {
        workspaceId,
        providerKey,
        authMethod,
        adapterKey,
        providerAccountRef,
        status: 'active',
        accessExpiresAt,
        refreshAfter,
      },
    })
    for (const b of bindings) {
      await tx.connectionSecretBinding.create({
        data: { connectionId: conn.id, vaultSecretId: b.secretId, purpose: b.purpose.trim() },
      })
    }
    return conn
  })

  await recordEvent({
    workspaceId,
    action: 'connection.create',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({ connection: { ...serializeConnection(connection), bindings: await loadBindings(connection.id) } }, 201)
})
