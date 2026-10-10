// POST /api/v1/internal/seed → 200 { ok, created, credentials }
// admin only. Idempotent: if isSeeded() is true, return current counts + the
// credentials read from vault-demo-credentials.json. Otherwise call seed()
// and return its result. Audits `seed.run`.
//
// SECURITY (R12): This endpoint is DISABLED in production. Seeding demo data
// (with demo client credentials written to a JSON file) is a dev/staging
// convenience that must never run against a production database. In
// production this returns 501 `production_mode_violation`.
import { handle, json, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { isProduction } from '@/lib/vault/env'
import { VaultError } from '@/lib/vault/errors'
import { isSeeded, seed } from '@/lib/vault/seed'
import { recordEvent } from '@/lib/vault/audit'
import { db } from '@/lib/db'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const CREDENTIALS_PATH = path.join(process.cwd(), 'vault-demo-credentials.json')

async function readClientCredentials(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as { clients?: Record<string, string> }
    return parsed.clients ?? {}
  } catch {
    return {}
  }
}

async function currentCounts(): Promise<Record<string, number>> {
  const [
    workspaces,
    serviceClients,
    vaultSecrets,
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
    vaultSecrets,
    secretVersions,
    connections,
    bindings,
    grants,
    rotationRuns,
    auditEvents,
  }
}

export const POST = handle(async (req) => {
  await adminOrThrow(req)

  // Production guard: seeding demo data + writing demo credentials to disk is
  // a dev/staging convenience that must never run in production.
  if (isProduction()) {
    throw new VaultError(
      'production_mode_violation',
      'Seed endpoint is disabled in production. Demo data and demo credentials are dev/staging only.',
    )
  }

  let result: { ok: boolean; created: Record<string, number>; credentials: Record<string, string> }
  if (await isSeeded()) {
    result = { ok: true, created: await currentCounts(), credentials: await readClientCredentials() }
  } else {
    result = await seed()
  }

  await recordEvent({
    action: 'seed.run',
    requestId: getRequestId(req),
    sourceIp: getSourceIp(req),
  })

  return json(result)
})
