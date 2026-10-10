// GET /api/v1/secrets/[id]/usage → 200 SecretUsageResponse
// "What breaks if this secret is revoked?" — collects every dependent
// ServiceClient (via grants), every IntegrationConnection (via bindings),
// and every SecretLease (any status) attached to a secret, plus a summary
// count of distinct clients / connections / active leases.
//
// Authorization: admin OR client with any grant on the secret
// (metadata:read is sufficient — they can see who else has access).
// Audit `secret.usage`. Value-free — no secret material referenced.
import { handle, json, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { recordEvent } from '@/lib/vault/audit'
import type {
  SecretUsageConnection,
  SecretUsageGrant,
  SecretUsageLease,
  SecretUsageResponse,
} from '@/lib/vault/types'

// Parse a comma-separated permissions string into a sorted unique array.
// Tolerates leading/trailing spaces, empty entries, and `[]`-style values.
function parsePermissions(raw: string): string[] {
  if (!raw) return []
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b))
}

export const GET = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  // 1. Load the secret. 404 if not found.
  const secret = await db.vaultSecret.findUnique({
    where: { id },
    select: { id: true, path: true, workspaceId: true },
  })
  if (!secret) throw new VaultError('secret_not_found')

  // 2. Authorize. Admin always. Client must be in the secret's workspace
  //    AND have ANY grant on the secret (metadata:read is sufficient —
  //    "any of the seven permissions counts as 'has a grant'", same rule
  //    used by GET /api/v1/secrets/[id]).
  if (auth.kind === 'client') {
    if (auth.client.workspaceId !== secret.workspaceId) {
      throw new VaultError('secret_access_denied')
    }
    const grant = await db.secretAccessGrant.findFirst({
      where: { serviceClientId: auth.client.id, vaultSecretId: id },
      select: { id: true },
    })
    if (!grant) throw new VaultError('secret_access_denied')
  }

  // 3. Load grants + their owning ServiceClient rows (name / type /
  //    lastUsedAt). One query via Prisma relation include.
  const grantRows = await db.secretAccessGrant.findMany({
    where: { vaultSecretId: id },
    include: {
      serviceClient: {
        select: { id: true, name: true, clientType: true, lastUsedAt: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  const grants: SecretUsageGrant[] = grantRows.map((g) => ({
    clientId: g.serviceClient?.id ?? g.serviceClientId,
    clientName: g.serviceClient?.name ?? '',
    clientType: g.serviceClient?.clientType ?? '',
    permissions: parsePermissions(g.permissions),
    lastUsedAt: g.serviceClient?.lastUsedAt
      ? g.serviceClient.lastUsedAt.toISOString()
      : null,
  }))

  // 4. Load connection bindings + their owning IntegrationConnection rows
  //    (providerKey / adapterKey / status / providerAccountRef).
  const bindingRows = await db.connectionSecretBinding.findMany({
    where: { vaultSecretId: id },
    include: {
      connection: {
        select: {
          id: true,
          providerKey: true,
          adapterKey: true,
          status: true,
          providerAccountRef: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
  const connections: SecretUsageConnection[] = bindingRows.map((b) => ({
    connectionId: b.connection?.id ?? b.connectionId,
    providerKey: b.connection?.providerKey ?? '',
    adapterKey: b.connection?.adapterKey ?? '',
    status: b.connection?.status ?? '',
    purpose: b.purpose,
    providerAccountRef: b.connection?.providerAccountRef ?? null,
  }))

  // 5. Load leases (any status) + their owning ServiceClient name. SecretLease
  //    has no Prisma relation to ServiceClient, so resolve manually.
  const leaseRows = await db.secretLease.findMany({
    where: { vaultSecretId: id },
    select: {
      id: true,
      serviceClientId: true,
      expiresAt: true,
      status: true,
    },
    orderBy: { expiresAt: 'desc' },
  })
  const leaseClientIds = Array.from(
    new Set(leaseRows.map((l) => l.serviceClientId)),
  )
  const leaseClientRows =
    leaseClientIds.length === 0
      ? []
      : await db.serviceClient.findMany({
          where: { id: { in: leaseClientIds } },
          select: { id: true, name: true },
        })
  const leaseClientNameById = new Map<string, string>()
  for (const c of leaseClientRows) {
    leaseClientNameById.set(c.id, c.name)
  }
  const leases: SecretUsageLease[] = leaseRows.map((l) => ({
    leaseId: l.id,
    clientName: leaseClientNameById.get(l.serviceClientId) ?? '',
    expiresAt: l.expiresAt.toISOString(),
    status: l.status,
  }))

  // 6. Blast radius: distinct clients (grants), distinct connections
  //    (bindings), and active leases.
  const distinctClientIds = new Set(grants.map((g) => g.clientId))
  const distinctConnectionIds = new Set(connections.map((c) => c.connectionId))
  const activeLeaseCount = leases.filter((l) => l.status === 'active').length

  // 7. Audit (value-free — no secret material referenced).
  await recordEvent({
    workspaceId: secret.workspaceId,
    actorClientId: auth.kind === 'client' ? auth.client.id : null,
    vaultSecretId: id,
    action: 'secret.usage',
    outcome: 'success',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  const response: SecretUsageResponse = {
    secretId: secret.id,
    path: secret.path,
    usage: { grants, connections, leases },
    blastRadius: {
      clientCount: distinctClientIds.size,
      connectionCount: distinctConnectionIds.size,
      activeLeaseCount,
    },
  }
  return json(response)
})
