// server-only — generic OAuth2 refresh adapter.
// See VAULT_CONTRACT.md §6.
//
// Supports two modes:
//   - **Mock mode** (default in dev, `OAUTH_MOCK=1`): the original simulated
//     refresh — random success/failure distribution with synthetic tokens.
//   - **Real mode** (`OAUTH_MOCK=0`, default in production): makes a REAL
//     OAuth2 refresh against a configurable `OAUTH_TOKEN_URL` env var:
//       POST $OAUTH_TOKEN_URL
//       content-type: application/x-www-form-urlencoded
//       body: grant_type=refresh_token&refresh_token=<refresh_token>
//             (+client_id=<client_id>&client_secret=<client_secret> if both
//              bindings are present, for confidential clients)
//       → { access_token, refresh_token?, expires_in, error? }
//     All outbound HTTP goes through the SSRF guard (`boundedFetch`).
//
// For the demo (no real OAuth provider configured) we keep mock mode.

import { randomBytes } from 'node:crypto'

import { isProduction } from '../env'
import { VaultError } from '../errors'
import { boundedFetch } from '../ssrf'
import type { ProviderAdapter, RefreshArgs, RefreshResult } from './types'

// ---- Mode selection -------------------------------------------------------

function isMockMode(): boolean {
  const explicit = process.env.OAUTH_MOCK
  if (explicit === '0') return false
  if (explicit === '1') return true
  // Default: mock in dev, real in production.
  return !isProduction()
}

// ---- Mock-mode constants --------------------------------------------------

const ACCESS_TTL_MS = 60 * 60_000 // 60 minutes
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
 * Same shape as the Dhan adapter but with a shorter access-token TTL (60 min)
 * and an `OAUTH_` prefix. The simulated outcome distribution mirrors Dhan:
 * 70/15/10/5 + an independent 5% provider_error.
 */
async function refreshMock(args: RefreshArgs): Promise<RefreshResult> {
  await delay()

  if (Math.random() < 0.05) {
    return { ok: false, errorCode: 'provider_error' }
  }

  const refreshTokenBinding = findBinding(args, 'refresh_token')
  const clientIdBinding = findBinding(args, 'client_id')
  if (!refreshTokenBinding || !clientIdBinding) {
    return { ok: false, errorCode: 'invalid_grant' }
  }

  try {
    await refreshTokenBinding.decrypt()
    await clientIdBinding.decrypt()
  } catch {
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
        value: 'OAUTH_ACCESS_' + randomHex(16),
        expiresAt: new Date(now + ACCESS_TTL_MS).toISOString(),
      },
    ],
    refreshTokensRotated: [
      {
        purpose: 'refresh_token',
        newValue: 'OAUTH_REFRESH_' + randomHex(24),
      },
    ],
  }
}

// ---- Real-mode refresh ----------------------------------------------------

interface OAuthRefreshResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

function classifyHttpError(status: number): string {
  if (status === 401 || status === 403) return 'invalid_grant'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status < 600) return 'transient'
  return 'provider_error'
}

async function refreshReal(args: RefreshArgs): Promise<RefreshResult> {
  const tokenUrl = process.env.OAUTH_TOKEN_URL
  if (!tokenUrl) {
    // No real provider configured → permanent failure (operator must set the
    // env var or flip back to mock mode).
    return { ok: false, errorCode: 'invalid_grant' }
  }

  const refreshTokenBinding = findBinding(args, 'refresh_token')
  if (!refreshTokenBinding) {
    return { ok: false, errorCode: 'invalid_grant' }
  }

  let refreshToken: string
  try {
    refreshToken = await refreshTokenBinding.decrypt()
  } catch {
    return { ok: false, errorCode: 'invalid_grant' }
  }
  if (!refreshToken) {
    return { ok: false, errorCode: 'invalid_grant' }
  }

  // Build the form body. `client_id` / `client_secret` bindings are optional
  // — they're only added for confidential clients.
  const form = new URLSearchParams()
  form.set('grant_type', 'refresh_token')
  form.set('refresh_token', refreshToken)
  const clientIdBinding = findBinding(args, 'client_id')
  const clientSecretBinding = findBinding(args, 'client_secret')
  try {
    if (clientIdBinding) {
      const cid = await clientIdBinding.decrypt()
      if (cid) form.set('client_id', cid)
    }
    if (clientSecretBinding) {
      const csec = await clientSecretBinding.decrypt()
      if (csec) form.set('client_secret', csec)
    }
  } catch {
    return { ok: false, errorCode: 'invalid_grant' }
  }

  let res: Response
  try {
    res = await boundedFetch(
      tokenUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
      },
      { timeoutMs: 10_000 },
    )
  } catch (err) {
    if (err instanceof VaultError && err.code === 'provider_unavailable') {
      return { ok: false, errorCode: 'provider_error' }
    }
    return { ok: false, errorCode: 'transient' }
  }

  if (!res.ok) {
    return { ok: false, errorCode: classifyHttpError(res.status) }
  }

  let body: OAuthRefreshResponse
  try {
    body = (await res.json()) as OAuthRefreshResponse
  } catch {
    return { ok: false, errorCode: 'provider_error' }
  }

  // RFC 6749 allows the server to return `{"error": "invalid_grant"}` with
  // 200; honour that explicitly.
  if (body.error === 'invalid_grant') {
    return { ok: false, errorCode: 'invalid_grant' }
  }
  if (
    !body ||
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number' ||
    !body.access_token
  ) {
    return { ok: false, errorCode: 'provider_error' }
  }

  const now = Date.now()
  const expiresAt = new Date(now + body.expires_in * 1000).toISOString()
  const result: RefreshResult = {
    ok: true,
    newCredentials: [
      {
        purpose: 'access_token',
        value: body.access_token,
        expiresAt,
      },
    ],
  }
  if (typeof body.refresh_token === 'string' && body.refresh_token) {
    result.refreshTokensRotated = [
      { purpose: 'refresh_token', newValue: body.refresh_token },
    ]
  }
  return result
}

// ---- Adapter facade -------------------------------------------------------

export async function refresh(args: RefreshArgs): Promise<RefreshResult> {
  return isMockMode() ? refreshMock(args) : refreshReal(args)
}

export const oauthGenericAdapter: ProviderAdapter = {
  key: 'oauth2_generic',
  providerKey: 'oauth-generic',
  supportsRefresh: true,
  supportsReauth: false,
  refresh,
}
