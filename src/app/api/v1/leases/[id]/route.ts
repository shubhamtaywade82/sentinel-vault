// DELETE /api/v1/leases/[id] → 200 { lease: LeaseListItem }
// Admin OR the lease's own `serviceClientId` (a client may revoke its own
// active lease). Audits `lease.revoke`.
import { handle, json, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { revokeLease } from '@/lib/vault/leases'

export const DELETE = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  // Load the lease. The `SecretLease` model has no Prisma relations, so we
  // resolve the bound secret's workspaceId manually for the authz check.
  const lease = await db.secretLease.findUnique({ where: { id } })
  if (!lease) throw new VaultError('resource_not_found', 'lease not found')

  const secret = await db.vaultSecret.findUnique({
    where: { id: lease.vaultSecretId },
    select: { workspaceId: true },
  })
  const leaseWorkspaceId = secret?.workspaceId ?? ''

  if (auth.kind === 'client') {
    // Client may revoke only their own lease, and only if it belongs to their
    // workspace.
    if (
      auth.client.id !== lease.serviceClientId ||
      auth.client.workspaceId !== leaseWorkspaceId
    ) {
      throw new VaultError('grant_required', 'clients may only revoke their own leases')
    }
  }

  const updated = await revokeLease(id, {
    workspaceId: leaseWorkspaceId,
    actorClientId: auth.kind === 'client' ? auth.client.id : null,
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({ lease: updated })
})
