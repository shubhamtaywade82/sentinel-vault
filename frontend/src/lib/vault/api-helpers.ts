// @internal server-only helpers shared by every /api/v1/* route handler.
// See VAULT_CONTRACT.md §4. This module is NOT a route (it lives outside
// `src/app/api/v1/.../route.ts`), so the Next App Router route-collector
// ignores it.

import { resolveAuth, requireAdmin } from './auth'
import {
  errorEnvelope,
  errorResponse,
  jsonResponse,
  noStore,
  VaultError,
} from './errors'
import { getClientKey, rateLimit, type RateLimitOptions } from './rate-limit'

export { VaultError, errorResponse, jsonResponse, noStore }

// ---- Response helpers (re-exports with shorter names) --------------------

export const json = jsonResponse
export const err = errorResponse

// ---- Request parsing -----------------------------------------------------

/** Read JSON body with a safe fallback that throws `validation_failed`. */
export async function body<T = unknown>(req: Request): Promise<T> {
  try {
    const text = await req.text()
    if (text.length === 0) return {} as T
    return JSON.parse(text) as T
  } catch {
    throw new VaultError('validation_failed', 'Invalid JSON body')
  }
}

/** Parsed query string parameters. */
export function query(req: Request): URLSearchParams {
  return new URL(req.url).searchParams
}

// ---- Auth ----------------------------------------------------------------

/** Resolve the bearer token into admin / client / none. */
export async function actor(req: Request) {
  return resolveAuth(req)
}

/** Throws `admin_required` unless the request is from the admin realm. */
export async function adminOrThrow(req: Request): Promise<void> {
  return requireAdmin(req)
}

export type Auth = Awaited<ReturnType<typeof resolveAuth>>

/**
 * Resolve the effective workspaceId for the request.
 * - admin realm: returns the `?workspaceId=` param when present, else the
 *   caller-provided fallback (or undefined → caller should handle).
 * - client realm: ignores the param (clients are scoped to their own
 *   workspace) and returns the client's `workspaceId`.
 * - none realm: returns the param or fallback so the route can throw the
 *   appropriate 401/403 itself (it should NOT silently succeed).
 */
export async function workspaceIdFrom(
  req: Request,
  fallbackWorkspaceId?: string | null,
): Promise<{ workspaceId: string | undefined; auth: Auth }> {
  const auth = await resolveAuth(req)
  const param = query(req).get('workspaceId') || undefined
  if (auth.kind === 'client') {
    return { workspaceId: auth.client.workspaceId, auth }
  }
  return { workspaceId: param ?? fallbackWorkspaceId ?? undefined, auth }
}

// ---- Request metadata ----------------------------------------------------

export function getRequestId(req: Request): string | null {
  return req.headers.get('x-request-id') || null
}

export function getSourceIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip') || null
}

// ---- Handler wrapper -----------------------------------------------------

/**
 * Default rate limit applied to every request that isn't a health check.
 * 120 req/min per (token-prefix, IP) composite key. Overridable per-route
 * via `opts.rateLimitOpts` (used by sensitive mutation endpoints). Tunable
 * at deploy time via the `VAULT_RATE_LIMIT_PER_MIN` env var.
 *
 * NOTE: this is the per-instance limit. In a multi-instance deployment each
 * process gets its own quota, so the effective limit is
 * `N_instances × VAULT_RATE_LIMIT_PER_MIN`. For a true global limit, swap
 * the in-memory `rateLimit` in `./rate-limit` for a Redis/external store.
 */
const DEFAULT_RATE_LIMIT_PER_MIN = Number.parseInt(
  process.env.VAULT_RATE_LIMIT_PER_MIN || '120',
  10,
) || 120

/**
 * Paths that are exempt from rate limiting so liveness/readiness probes from
 * orchestrators (or the watchdog) can never be throttled.
 */
const RATE_LIMIT_EXEMPT_PATHS = new Set<string>([
  '/api/v1/health/live',
  '/api/v1/health/ready',
])

function isRateLimitExempt(req: Request): boolean {
  try {
    const u = new URL(req.url)
    return RATE_LIMIT_EXEMPT_PATHS.has(u.pathname)
  } catch {
    // Malformed URL — don't crash the wrapper; just don't rate-limit it
    // (downstream code will likely throw anyway).
    return false
  }
}

/**
 * Wrap a route handler so any thrown `VaultError` (or anything else) is
 * mapped to the standard `{ error: { code, message, details? } }` envelope
 * with the right HTTP status. Use as:
 *
 *   export const POST = handle(async (req) => { ... })
 *   export const GET = handle(async (req, ctx) => { ... })
 *
 * Before the handler runs, an in-memory token-bucket rate limit is applied
 * (per (token-prefix, source-IP) key). On denial the wrapper returns a
 * `rate_limited` (429) response with a `Retry-After` header. Health-check
 * paths (`/api/v1/health/live`, `/api/v1/health/ready`) are exempt.
 *
 * Pass `opts.rateLimitOpts` to tighten the limit for a sensitive endpoint
 * (e.g. reveal/rotate/revoke use 30/min).
 */
export function handle<TArgs extends unknown[]>(
  fn: (req: Request, ...args: TArgs) => Promise<Response>,
  opts?: { rateLimitOpts?: RateLimitOptions },
): (req: Request, ...args: TArgs) => Promise<Response> {
  return async (req, ...args) => {
    try {
      if (!isRateLimitExempt(req)) {
        const rlOpts: RateLimitOptions =
          opts?.rateLimitOpts ?? { requestsPerMinute: DEFAULT_RATE_LIMIT_PER_MIN }
        const decision = rateLimit(getClientKey(req), rlOpts)
        if (!decision.allowed) {
          const retryAfterSec = Math.max(
            1,
            Math.ceil((decision.resetAt - Date.now()) / 1000),
          )
          const err = new VaultError(
            'rate_limited',
            'Rate limit exceeded — too many requests',
            { retryAfter: retryAfterSec },
          )
          const { status, body } = errorEnvelope(err)
          return jsonResponse(body, status, {
            'retry-after': String(retryAfterSec),
            'cache-control': 'no-store',
          })
        }
      }
      return await fn(req, ...args)
    } catch (e) {
      return errorResponse(e)
    }
  }
}

// ---- Small misc helpers --------------------------------------------------

export function notEmpty<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined
}

export function asString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Parse a positive integer query param with a fallback. */
export function asInt(v: string | null, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
