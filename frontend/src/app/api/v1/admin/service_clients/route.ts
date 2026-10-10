// /api/v1/admin/service_clients — admin only.
// GET  → 200 { clients: ClientListItem[] }
// POST → 201 { client, credential }   (credential returned ONCE)
import { handle, json, body, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError, assert } from '@/lib/vault/errors'
import { sha256Hex } from '@/lib/vault/auth'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const CREDENTIALS_PATH = path.join(process.cwd(), 'vault-demo-credentials.json')
const CLIENT_TYPES = new Set(['bot', 'app', 'gateway', 'cli', 'mcp', 'worker'])

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

async function appendCredentialToFile(clientName: string, credential: string): Promise<void> {
  let file: { admin?: string; clients?: Record<string, string> } = {}
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH, 'utf8')
    file = JSON.parse(raw)
  } catch {
    /* ignore — file may not exist yet */
  }
  if (!file.clients || typeof file.clients !== 'object') file.clients = {}
  file.clients[clientName] = credential
  await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8')
}

export const GET = handle(async (req) => {
  await adminOrThrow(req)
  const workspaceId = new URL(req.url).searchParams.get('workspaceId') || undefined

  const where = workspaceId ? { workspaceId } : {}
  const rows = await db.serviceClient.findMany({
    where,
    include: { workspace: true, _count: { select: { grants: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const clients = rows.map((c) => ({
    ...serializeClient(c),
    workspaceSlug: c.workspace.slug,
    grantsCount: c._count.grants,
  }))

  return json({ clients })
})

export const POST = handle(async (req) => {
  await adminOrThrow(req)
  const input = await body<{
    name?: string
    clientType?: string
    workspaceId?: string
    expiresInDays?: number
  }>(req)

  const name = (input.name || '').trim()
  const clientType = (input.clientType || '').trim()
  const workspaceId = (input.workspaceId || '').trim()
  assert(name && clientType && workspaceId, 'validation_failed', 'name, clientType, workspaceId required')
  assert(CLIENT_TYPES.has(clientType), 'validation_failed', `clientType must be one of: ${Array.from(CLIENT_TYPES).join(', ')}`)

  const ws = await db.workspace.findUnique({ where: { id: workspaceId } })
  if (!ws) throw new VaultError('workspace_not_found', 'workspace not found')

  // De-dupe name within workspace for clarity (not enforced by DB unique).
  const existingName = await db.serviceClient.findFirst({ where: { workspaceId, name } })
  if (existingName) throw new VaultError('conflict', 'client name already exists in this workspace')

  const publicId = `clt_${randomHex(8)}`
  const credential = `vlt_live_${randomHex(32)}`
  const credentialDigest = sha256Hex(credential)
  const credentialPrefix = credential.slice(0, 10)
  const expiresAt =
    typeof input.expiresInDays === 'number' && input.expiresInDays > 0
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null

  const client = await db.serviceClient.create({
    data: {
      workspaceId,
      publicId,
      name,
      clientType,
      credentialDigest,
      credentialPrefix,
      status: 'active',
      expiresAt,
    },
  })

  await appendCredentialToFile(name, credential)
  await recordEventCritical({
    workspaceId,
    action: 'client.create',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json({ client: serializeClient(client), credential }, 201)
})
