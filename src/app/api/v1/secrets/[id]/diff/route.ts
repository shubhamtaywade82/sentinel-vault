// POST /api/v1/secrets/[id]/diff → 200 noStore { secret, versionA, versionB, valueA, valueB, diff }
// Decrypts two versions of a secret and returns a line-by-line unified diff.
// admin realm:  requires `admin_reveal_ok=true` query param.
// client realm: requires `value:read` grant.
// Audit `secret.diff` with success/denied outcome.
import { handle, noStore, body, actor, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { db } from '@/lib/db'
import { VaultError } from '@/lib/vault/errors'
import { decryptValue } from '@/lib/vault/crypto'
import { checkGrant } from '@/lib/vault/authorization'
import { recordEvent, recordEventCritical } from '@/lib/vault/audit'

interface DiffBody {
  versionAId: string
  versionBId: string
}

interface DiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
  aLine?: number
  bLine?: number
}

// Simple LCS-based line diff (no external dep).
function lineDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'context', text: a[i], aLine: i + 1, bLine: j + 1 })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: a[i], aLine: i + 1 })
      i++
    } else {
      result.push({ type: 'add', text: b[j], bLine: j + 1 })
      j++
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: a[i], aLine: i + 1 })
    i++
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j], bLine: j + 1 })
    j++
  }
  return result
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

export const POST = handle(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params
  const auth = await actor(req)
  if (auth.kind === 'none') throw new VaultError('unauthorized')

  const secret = await db.vaultSecret.findUnique({ where: { id } })
  if (!secret) throw new VaultError('secret_not_found')

  const requestId = getRequestId(req)
  const sourceIp = getSourceIp(req)
  const parsed = await body<DiffBody>(req)
  if (!parsed.versionAId || !parsed.versionBId) {
    throw new VaultError('validation_failed', 'versionAId and versionBId are required')
  }

  // Authorization (same as reveal — requires value:read)
  let denied = false
  if (auth.kind === 'admin') {
    const ok = new URL(req.url).searchParams.get('admin_reveal_ok') === 'true'
    if (!ok) denied = true
  } else if (auth.kind === 'client') {
    if (auth.client.workspaceId !== secret.workspaceId) denied = true
    else {
      const ok = await checkGrant(auth.client.id, id, 'value:read')
      if (!ok) denied = true
    }
  }

  if (denied) {
    await recordEvent({
      workspaceId: secret.workspaceId,
      actorClientId: auth.kind === 'client' ? auth.client.id : null,
      vaultSecretId: id,
      action: 'secret.diff',
      outcome: 'denied',
      reasonCode: auth.kind === 'admin' ? 'admin_reveal_required' : 'value:read',
      requestId,
      sourceIp,
    })
    if (auth.kind === 'admin') {
      throw new VaultError('admin_required', 'admin diff requires admin_reveal_ok=true query flag')
    }
    throw new VaultError('grant_required', 'Missing grant: value:read on ' + id)
  }

  // Load both versions
  const [versionA, versionB] = await Promise.all([
    db.secretVersion.findUnique({ where: { id: parsed.versionAId } }),
    db.secretVersion.findUnique({ where: { id: parsed.versionBId } }),
  ])
  if (!versionA || versionA.vaultSecretId !== id) throw new VaultError('version_not_found', 'versionA not found for this secret')
  if (!versionB || versionB.vaultSecretId !== id) throw new VaultError('version_not_found', 'versionB not found for this secret')

  // Decrypt both with AAD bound to their version number
  const aadA = { workspaceId: secret.workspaceId, vaultSecretId: id, versionNumber: versionA.versionNumber }
  const aadB = { workspaceId: secret.workspaceId, vaultSecretId: id, versionNumber: versionB.versionNumber }
  const valueA = await decryptValue(
    { ciphertext: versionA.ciphertext, encryptedDataKey: versionA.encryptedDataKey, kmsKeyRef: versionA.kmsKeyRef },
    aadA,
    {
      secretVersionId: versionA.id,
      actorClientId: auth.kind === 'client' ? auth.client.id : null,
      requestId,
    },
  )
  const valueB = await decryptValue(
    { ciphertext: versionB.ciphertext, encryptedDataKey: versionB.encryptedDataKey, kmsKeyRef: versionB.kmsKeyRef },
    aadB,
    {
      secretVersionId: versionB.id,
      actorClientId: auth.kind === 'client' ? auth.client.id : null,
      requestId,
    },
  )

  // Compute diff
  const linesA = valueA.split('\n')
  const linesB = valueB.split('\n')
  const diff = lineDiff(linesA, linesB)

  await recordEventCritical({
    workspaceId: secret.workspaceId,
    actorClientId: auth.kind === 'client' ? auth.client.id : null,
    vaultSecretId: id,
    secretVersionId: versionB.id,
    action: 'secret.diff',
    outcome: 'success',
    reasonCode: `v${versionA.versionNumber}→v${versionB.versionNumber}`,
    requestId,
    sourceIp,
  })

  return noStore({
    versionA: serializeVersion(versionA),
    versionB: serializeVersion(versionB),
    valueA,
    valueB,
    diff,
    stats: {
      additions: diff.filter((d) => d.type === 'add').length,
      removals: diff.filter((d) => d.type === 'remove').length,
      context: diff.filter((d) => d.type === 'context').length,
    },
  })
})
