// POST /api/v1/admin/service_clients/[id]/rotate_credential
// Returns 200 { client, credential } with the new credential (shown once).
import { handle, json, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { sha256Hex } from '@/lib/vault/auth'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const CREDENTIALS_PATH = path.join(process.cwd(), 'vault-demo-credentials.json')
function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

function serializeClient(c: {
  id: string
  workspaceId: string
  publicId: string
  name: string
  clientType: string
  credentialDigest: string
  credentialPrefix: string
  status: string
  expiresAt: Date | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    publicId: c.publicId,
    name: c.name,
    clientType: c.clientType,
    credentialDigest: c.credentialDigest,
    credentialPrefix: c.credentialPrefix,
    status: c.status,
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
    revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }
}

export const POST = handle(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    await adminOrThrow(req)
    const { id } = await ctx.params
    const existing = await db.serviceClient.findUnique({ where: { id } })
    if (!existing) throw new VaultError('client_not_found')

    const credential = `vlt_live_${randomHex(32)}`
    const credentialDigest = sha256Hex(credential)
    const credentialPrefix = credential.slice(0, 10)

    const updated = await db.serviceClient.update({
      where: { id },
      data: {
        credentialDigest,
        credentialPrefix,
        status: 'active',
        revokedAt: null,
        updatedAt: new Date(),
      },
    })

    // Persist the new credential so the demo can still authenticate after a reload.
    try {
      let file: { admin?: string; clients?: Record<string, string> } = {}
      try {
        file = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'))
      } catch {
        /* ignore */
      }
      if (!file.clients) file.clients = {}
      file.clients[updated.name] = credential
      await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8')
    } catch (e) {
      console.warn('[vault] failed to persist rotated credential:', e)
    }

    await recordEventCritical({
      workspaceId: updated.workspaceId,
      actorClientId: updated.id,
      action: 'client.rotate',
      requestId: getRequestId(req),
      sourceIp: getSourceIp(req),
    })

    return json({ client: serializeClient(updated), credential })
  },
  // Tight rate limit — rotating a service-client credential issues a new
  // credential the caller must persist. 30 req/min per (token, IP) key to
  // prevent abuse (mass client re-issue / credential-storm).
  { rateLimitOpts: { requestsPerMinute: 30, burst: 30 } },
)
