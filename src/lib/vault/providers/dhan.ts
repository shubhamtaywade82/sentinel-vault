// server-only — Dhan OAuth2 refresh adapter.
// See VAULT_CONTRACT.md §6.
//
// Supports two modes:
//   - **Mock mode** (default in dev, `DHAN_MOCK=1`): the original simulated
//     refresh — random success/failure distribution with synthetic tokens.
//     Lets the demo work without real Dhan credentials.
//   - **Real mode** (`DHAN_MOCK=0`, default in production): makes a REAL
//     OAuth2 refresh against Dhan's public API contract:
//       POST https://api.dhan.in/auth/v2/refresh
//       body: { refresh_token: <current_refresh_token> }
//       → { access_token, refresh_token, expires_in }   (refresh ROTATED)
//     All outbound HTTP goes through the SSRF guard (`boundedFetch`) with
//     `allowedHosts: ['api.dhan.in']`.
//
// The refresh-token rotation is honoured: the old refresh token is
// invalidated by Dhan and the new one is persisted via
// `refreshTokensRotated`.

import { randomBytes } from 'node:crypto'

import { isProduction } from '../env'
import { VaultError } from '../errors'
import { boundedFetch } from '../ssrf'
import type { ProviderAdapter, RefreshArgs, RefreshResult } from './types'

// ---- Mode selection -------------------------------------------------------

function isMockMode(): boolean {
  const explicit = process.env.DHAN_MOCK
  if (explicit === '0') return false
  if (explicit === '1') return true
  // Default: mock in dev, real in production.
  return !isProduction()
}

// ---- Mock-mode constants (preserved from the original simulated adapter) --

const ACCESS_TTL_MS = 120 * 60_000 // 120 minutes
const NETWORK_DELAY_MIN_MS = 50
const NETWORK_DELAY_MAX_MS = 150

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

function delay(): Promise<void> {
  const ms =
    NETWORK_DELAY_MIN_MS +
    Math.floor(Math.random() * (NETWORK_DELAY_MAX_MS - NETWORK_DELAY_MIN_MS))
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findBinding(args: RefreshArgs, purpose: string) {
  return args.bindings.find((b) => b.purpose === purpose)
}

// ---- Mock-mode refresh ----------------------------------------------------

/**
 * Simulated OAuth2 refresh. Reads only the `refresh_token` and `client_id`
 * bindings (calling `decrypt()` lazily for each).
 *
 * Outcome distribution (per VAULT_CONTRACT.md §6 + task spec):
 *   - 70% success (access expiry = now + 120min, refresh token ROTATED)
 *   - 15% invalid_grant (PERMANENT)
 *   - 10% transient
 *   -  5% rate_limited
 *   - plus an independent 5% provider_error (transient, exercises that path)
 */
async function refreshMock(args: RefreshArgs): Promise<RefreshResult> {
  await delay()

  // Independent provider-error roll on top of the main distribution.
  if (Math.random() < 0.05) {
    return { ok: false, errorCode: 'provider_error' }
  }

  // Validate we have the bindings we need BEFORE the roll, so a misconfigured
  // connection is detectable regardless of the random outcome.
  const refreshTokenBinding = findBinding(args, 'refresh_token')
  const clientIdBinding = findBinding(args, 'client_id')
  if (!refreshTokenBinding || !clientIdBinding) {
    // Treat missing bindings as a permanent configuration error.
    return { ok: false, errorCode: 'invalid_grant' }
  }

  // Decrypt only what this adapter actually needs.
  // (Even though the simulated HTTP call doesn't use the plaintext value
  // mathematically, we honor the "decrypt only what you need" contract.)
  try {
    await refreshTokenBinding.decrypt()
    await clientIdBinding.decrypt()
  } catch {
    // Decryption failure → treat as permanent auth problems from the adapter's
    // perspective; the engine maps to reauth_required.
    return { ok: false, errorCode: 'invalid_grant' }
  }

  const roll = Math.random()
  if (roll < 0.15) {
    return { ok: false, errorCode: 'invalid_grant' }
  }
  if (roll < 0.25) {
    return { ok: false, errorCode: 'transient' }
  }
  if (roll < 0.3) {
    return { ok: false, errorCode: 'rate_limited' }
  }

  const now = Date.now()
  return {
    ok: true,
    newCredentials: [
      {
        purpose: 'access_token',
        value: 'DHAN_ACCESS_' + randomHex(16),
        expiresAt: new Date(now + ACCESS_TTL_MS).toISOString(),
      },
    ],
    refreshTokensRotated: [
      {
        purpose: 'refresh_token',
        newValue: 'DHAN_REFRESH_' + randomHex(24),
      },
    ],
  }
}

// ---- Real-mode refresh ----------------------------------------------------
//
// Dhan's public OAuth2 refresh contract:
//   POST https://api.dhan.in/auth/v2/refresh
//   content-type: application/json
//   body: { refresh_token: <current_refresh_token> }
//   → 200 { access_token, refresh_token, expires_in }   (seconds)
//
// Dhan rotates the refresh token on every refresh — the previous refresh
// token is invalidated. We surface this via `refreshTokensRotated`.
//
// The adapter also needs the `client_id` binding (Dhan access key) for the
// token-generation endpoint; we decrypt it lazily here even though the
// refresh endpoint only needs the refresh_token, so a misconfigured
// connection is detectable and so the same binding-check covers the token
// re-issue path the engine may use later.

const DHAN_REFRESH_URL = 'https://api.dhan.in/auth/v2/refresh'
const DHAN_ALLOWED_HOSTS = ['api.dhan.in']
const DHAN_FETCH_TIMEOUT_MS = 10_000

interface DhanRefreshResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  status?: 'success' | 'error'
  errorCode?: string
  errorMessage?: string
}

function classifyHttpError(status: number): string {
  if (status === 401 || status === 403) return 'invalid_grant'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status < 600) return 'transient'
  return 'provider_error'
}

async function refreshReal(args: RefreshArgs): Promise<RefreshResult> {
  const refreshTokenBinding = findBinding(args, 'refresh_token')
  const clientIdBinding = findBinding(args, 'client_id')
  if (!refreshTokenBinding || !clientIdBinding) {
    return { ok: false, errorCode: 'invalid_grant' }
  }

  // Decrypt lazily — only what this adapter actually needs. The refresh
  // endpoint only needs the refresh_token, but we also decrypt client_id so
  // the same binding check covers the (future) token re-issue path.
  let refreshToken: string
  let clientId: string
  try {
    refreshToken = await refreshTokenBinding.decrypt()
    clientId = await clientIdBinding.decrypt()
  } catch {
    return { ok: false, errorCode: 'invalid_grant' }
  }

  // Sanity: refresh_token + client_id must be non-empty.
  if (!refreshToken || !clientId) {
    return { ok: false, errorCode: 'invalid_grant' }
  }

  let res: Response
  try {
    res = await boundedFetch(
      DHAN_REFRESH_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
      {
        timeoutMs: DHAN_FETCH_TIMEOUT_MS,
        allowedHosts: DHAN_ALLOWED_HOSTS,
      },
    )
  } catch (err) {
    // SSRF rejection (provider_unavailable) and network/timeout failures all
    // map to transient from the engine's perspective — the engine will retry
    // with exponential backoff. We surface the message for the audit log.
    if (err instanceof VaultError && err.code === 'provider_unavailable') {
      // SSRF guard rejected — this is a hard configuration error, not a
      // transient network blip. Treat as provider_error (still transient
      // category in the engine, surfaces in the run log).
      return { ok: false, errorCode: 'provider_error' }
    }
    // Network failure / timeout → transient.
    return { ok: false, errorCode: 'transient' }
  }

  if (!res.ok) {
    return { ok: false, errorCode: classifyHttpError(res.status) }
  }

  let body: DhanRefreshResponse
  try {
    body = (await res.json()) as DhanRefreshResponse
  } catch {
    return { ok: false, errorCode: 'provider_error' }
  }

  // Malformed body → provider_error (transient).
  if (
    !body ||
    typeof body.access_token !== 'string' ||
    typeof body.refresh_token !== 'string' ||
    typeof body.expires_in !== 'number' ||
    !body.access_token ||
    !body.refresh_token
  ) {
    return { ok: false, errorCode: 'provider_error' }
  }

  const now = Date.now()
  const expiresAt = new Date(now + body.expires_in * 1000).toISOString()
  return {
    ok: true,
    newCredentials: [
      {
        purpose: 'access_token',
        value: body.access_token,
        expiresAt,
      },
    ],
    refreshTokensRotated: [
      {
        purpose: 'refresh_token',
        newValue: body.refresh_token,
      },
    ],
  }
}

// ---- Adapter facade -------------------------------------------------------

export async function refresh(args: RefreshArgs): Promise<RefreshResult> {
  return isMockMode() ? refreshMock(args) : refreshReal(args)
}

export const dhanAdapter: ProviderAdapter = {
  key: 'dhan_v1',
  providerKey: 'dhan',
  supportsRefresh: true,
  supportsReauth: false,
  refresh,
}
