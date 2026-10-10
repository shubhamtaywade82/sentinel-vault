#!/usr/bin/env bun
// scripts/security-check.mjs
//
// Security regression tests for Sentinel Vault (R12 hardening).
// Runs negative + positive tests against the running vault API on :4750.
// Exits non-zero if any check fails.
//
// Usage:
//   bun scripts/security-check.mjs
//
// Requires the dev server running on http://localhost:4750 with the demo data
// seeded (POST /api/v1/internal/seed). The admin token is read from
// VAULT_ADMIN_TOKEN or defaults to the demo token.

const VAULT_URL = process.env.VAULT_URL || 'http://localhost:4750'
const ADMIN_TOKEN = process.env.VAULT_ADMIN_TOKEN || 'vault-admin-demo-token-CHANGE-ME'

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`)
  } else {
    fail++
    failures.push(`${name}: ${detail || ''}`)
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} — ${detail || ''}`)
  }
}

async function admin(path, init) {
  const res = await fetch(`${VAULT_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init?.headers || {}),
    },
  })
  let body = null
  const text = await res.text()
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: res.status, body, headers: res.headers }
}

async function asClient(token, path, init) {
  const res = await fetch(`${VAULT_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  })
  let body = null
  const text = await res.text()
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: res.status, body }
}

// ---------------------------------------------------------------------------
console.log('\n\x1b[1mSentinel Vault — Security Regression Tests (R12)\x1b[0m\n')

// ---- Setup: resolve workspace + secret + client ids ----
console.log('Setup:')
const wsRes = await admin('/api/v1/workspaces')
check('admin can list workspaces', wsRes.status === 200, `got ${wsRes.status}`)
const workspaces = wsRes.body?.workspaces || []
const prod = workspaces.find((w) => w.slug === 'production')
const staging = workspaces.find((w) => w.slug === 'staging')
check('production workspace exists', !!prod, 'no production workspace')
check('staging workspace exists', !!staging, 'no staging workspace')

const secretsRes = await admin(`/api/v1/secrets?workspaceId=${prod.id}`)
const secrets = secretsRes.body?.secrets || []
check('production has secrets', secrets.length > 0, 'no secrets')
const aSecret = secrets.find((s) => s.path === 'dhan/prod/access-token')
check('dhan/prod/access-token exists', !!aSecret, 'missing')

const clientsRes = await admin(`/api/v1/admin/service_clients?workspaceId=${prod.id}`)
const clients = clientsRes.body?.clients || []
const algoBot = clients.find((c) => c.name === 'algo-scalper-bot')
check('algo-scalper-bot client exists', !!algoBot, 'missing')

// Load demo credentials to get a client token
let clientToken = null
try {
  const credsRes = await admin('/api/v1/internal/demo-credentials')
  clientToken = credsRes.body?.clients?.['algo-scalper-bot']
} catch { /* may be disabled in prod */ }
check('algo-scalper-bot credential loadable', !!clientToken, 'no token from demo-credentials')

if (!prod || !staging || !aSecret || !algoBot || !clientToken) {
  console.log('\n\x1b[33mSetup incomplete — skipping remaining tests.\x1b[0m')
  console.log(`\nResults: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

// ---- Test 1: Reveal without admin_reveal_ok should be denied ----
console.log('\nTest 1: Admin reveal without admin_reveal_ok query flag')
const revealNoFlag = await admin(`/api/v1/secrets/${aSecret.id}/reveal`, {
  method: 'POST',
  body: JSON.stringify({}),
})
check(
  'admin reveal without admin_reveal_ok → 403 admin_required',
  revealNoFlag.status === 403 && revealNoFlag.body?.error?.code === 'admin_required',
  `got status=${revealNoFlag.status} code=${revealNoFlag.body?.error?.code}`,
)

// ---- Test 2: Client reveal WITHOUT value:read grant → denied ----
console.log('Test 2: Client reveal without value:read grant')
// Find a secret the bot has NO grant on (e.g. dhan/prod/totp-seed)
const totpSecret = secrets.find((s) => s.path === 'dhan/prod/totp-seed')
if (totpSecret) {
  const deniedReveal = await asClient(
    clientToken,
    `/api/v1/secrets/${totpSecret.id}/reveal`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  check(
    'client reveal without grant → 403',
    deniedReveal.status === 403,
    `got status=${deniedReveal.status} code=${deniedReveal.body?.error?.code}`,
  )
} else {
  console.log('  SKIP — no totp-seed secret to test denial')
}

// ---- Test 3: Client CANNOT access a secret in a DIFFERENT workspace ----
console.log('Test 3: Cross-workspace access denied')
// algo-scalper-bot is in production. Try to read a staging secret.
const stagingSecretsRes = await admin(`/api/v1/secrets?workspaceId=${staging.id}`)
const stagingSecrets = stagingSecretsRes.body?.secrets || []
if (stagingSecrets.length > 0) {
  const stagingSecret = stagingSecrets[0]
  // The client lists secrets — the API should only return their own workspace's
  // granted secrets. A staging secret should NOT appear for a production client.
  const clientListRes = await asClient(
    clientToken,
    `/api/v1/secrets?workspaceId=${prod.id}`,
  )
  const clientSecrets = clientListRes.body?.secrets || []
  const crossLeak = clientSecrets.find((s) => s.workspaceId === staging.id)
  check(
    'client list does not leak cross-workspace secrets',
    !crossLeak,
    `found staging secret in production client list`,
  )
  // Also try direct GET on a staging secret
  const crossGet = await asClient(clientToken, `/api/v1/secrets/${stagingSecret.id}`)
  check(
    'client GET on foreign-workspace secret → 403/404',
    crossGet.status === 403 || crossGet.status === 404,
    `got status=${crossGet.status}`,
  )
} else {
  console.log('  SKIP — no staging secrets')
}

// ---- Test 4: Unauthenticated request → 401 ----
console.log('Test 4: Unauthenticated access denied')
const noAuthRes = await fetch(`${VAULT_URL}/api/v1/secrets`)
check(
  'no auth → 401 unauthorized',
  noAuthRes.status === 401,
  `got status=${noAuthRes.status}`,
)

// ---- Test 5: Wrong admin token → 401/403 ----
console.log('Test 5: Wrong admin token denied')
const wrongAuthRes = await fetch(`${VAULT_URL}/api/v1/workspaces`, {
  headers: { authorization: 'Bearer wrong-token-xyz' },
})
check(
  'wrong token → 401 or 403',
  wrongAuthRes.status === 401 || wrongAuthRes.status === 403,
  `got status=${wrongAuthRes.status}`,
)

// ---- Test 6: Client with value:read CAN reveal its granted secret ----
console.log('Test 6: Authorized client reveal succeeds')
if (clientToken && aSecret) {
  const okReveal = await asClient(
    clientToken,
    `/api/v1/secrets/${aSecret.id}/reveal`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  check(
    'client reveal with grant → 200',
    okReveal.status === 200,
    `got status=${okReveal.status} code=${okReveal.body?.error?.code}`,
  )
  check(
    'revealed value is non-empty plaintext',
    typeof okReveal.body?.value === 'string' && okReveal.body.value.length > 0,
    'no value field',
  )
}

// ---- Test 7: Cache-Control no-store on plaintext responses ----
console.log('Test 7: no-store cache-control on reveal')
if (clientToken && aSecret) {
  const revealRes = await asClient(
    clientToken,
    `/api/v1/secrets/${aSecret.id}/reveal`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  // asClient doesn't return headers; re-fetch to check
  const revealWithHeaders = await fetch(
    `${VAULT_URL}/api/v1/secrets/${aSecret.id}/reveal`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${clientToken}`,
      },
      body: JSON.stringify({}),
    },
  )
  const cc = revealWithHeaders.headers.get('cache-control') || ''
  check(
    'reveal has Cache-Control: no-store',
    cc.includes('no-store'),
    `cache-control: ${cc}`,
  )
}

// ---- Test 8: Audit event recorded for the reveal ----
console.log('Test 8: Audit trail records reveals')
const auditRes = await admin(`/api/v1/audit_events?limit=50`)
const events = auditRes.body?.events || []
const revealEvent = events.find((e) => e.action === 'secret.reveal' && e.outcome === 'success')
check(
  'audit has a secret.reveal success event',
  !!revealEvent,
  'no secret.reveal success event found',
)
check(
  'audit event has NO secret value field',
  revealEvent && !('value' in (revealEvent || {})),
  'audit event leaked a value field',
)

// ---- Summary ----
console.log(`\n\x1b[1mResults: ${pass} pass, ${fail} fail\x1b[0m`)
if (fail > 0) {
  console.log('\n\x1b[31mFailures:\x1b[0m')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n\x1b[32mAll security regression tests passed.\x1b[0m')
process.exit(0)
