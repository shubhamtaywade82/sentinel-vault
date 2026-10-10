// In-memory token-bucket rate limiter for Sentinel Vault.
//
// Design notes (R13):
// - **Single-instance only.** Buckets live in a process-local `Map`; with the
//   sandbox's single Next.js dev server that is fine. For multi-instance
//   deployments (or serverless) this MUST be replaced with a shared store
//   (Redis, DynamoDB, etc.) — otherwise each instance gets its own quota and
//   the effective limit becomes `N × per-instance-limit`. See VAULT_CONTRACT
//   §4 — `rateLimit` is the seam that a distributed implementation swaps in.
// - **Token-bucket.** Each key gets a bucket of `burst` tokens that refills
//   at `requestsPerMinute / 60` tokens / second. A request consumes 1 token;
//   when the bucket is empty the request is denied with `resetAt` pointing
//   at the moment the next token will be available. The bucket size = burst
//   permits short spikes while capping the sustained rate.
// - **Lazy eviction.** To bound memory in pathological cases (lots of unique
//   keys), once the map exceeds 10,000 entries we drop the oldest 1,000
//   (insertion-order iteration via `Map.keys()`). This is LRU-ish, not a
//   perfect LRU — we don't track access time. Good enough for an unbounded
//   untrusted-key space.
// - **Key derivation.** `getClientKey(req)` does NOT resolve full auth (that
//   hits the DB). Instead it derives a composite key from the bearer-token
//   prefix (first 10 chars — enough to distinguish demo credentials, the
//   admin token, and individual client tokens from each other) plus the
//   source IP. This means a single client behind a NAT gets one bucket (so
//   one compromised client can't starve its neighbours), and a single IP
//   rotating across many clients gets separate buckets per client+IP. The
//   admin token's prefix collides only with itself; admins are rate-limited
//   too. Fully anonymous requests (no bearer, no x-forwarded-for, no
//   x-real-ip) collapse to the constant `anon` bucket — fine for health and
//   read endpoints, but those are mostly authed anyway.

// Inlined source-IP extraction (same precedence as `getSourceIp` in
// api-helpers) to avoid a circular import: api-helpers.ts will import this
// module's `rateLimit` / `getClientKey`, so we don't want this module to
// import back from api-helpers.
function sourceIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip') || null
}

export interface RateLimitOptions {
  /** Sustained refill rate (tokens per minute). */
  requestsPerMinute: number
  /** Bucket capacity / instant burst. Defaults to `requestsPerMinute`. */
  burst?: number
}

export interface RateLimitResult {
  allowed: boolean
  /** Tokens left after this call (clamped to >= 0). */
  remaining: number
  /** Epoch ms when the next token becomes available (only meaningful when `allowed === false`). */
  resetAt: number
}

interface Bucket {
  tokens: number
  lastRefill: number
}

const MAX_BUCKETS = 10_000
const EVICT_COUNT = 1_000

// Process-local store. Single-instance only — see file header.
const buckets = new Map<string, Bucket>()

/**
 * Token-bucket rate limiter. Mutates the per-key bucket in place (refill +
 * consume) and returns the decision. Lazily evicts old buckets when the map
 * grows past `MAX_BUCKETS` so memory is bounded in the untrusted-key case.
 */
export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const burst = opts.burst ?? opts.requestsPerMinute
  const refillPerSec = opts.requestsPerMinute / 60

  const now = Date.now()
  let bucket = buckets.get(key)

  if (!bucket) {
    // Lazy eviction BEFORE inserting so we never transiently exceed the cap
    // by more than one entry. Map iteration is insertion-order, so the first
    // EVICT_COUNT entries are the oldest — drop them.
    if (buckets.size >= MAX_BUCKETS) {
      let dropped = 0
      for (const k of buckets.keys()) {
        buckets.delete(k)
        if (++dropped >= EVICT_COUNT) break
      }
    }
    // Start full — first request from a new key always succeeds (unless the
    // caller passes a burst of 0, which would be a misconfiguration).
    bucket = { tokens: burst, lastRefill: now }
    buckets.set(key, bucket)
  } else {
    // Refill: elapsed time × refill rate, capped at `burst`.
    const elapsedSec = (now - bucket.lastRefill) / 1000
    if (elapsedSec > 0) {
      const refilled = bucket.tokens + elapsedSec * refillPerSec
      bucket.tokens = Math.min(burst, refilled)
      bucket.lastRefill = now
    }
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetAt: now,
    }
  }

  // Bucket is empty — compute when the next token will be available.
  // With refillPerSec tokens/sec, one full token takes 1/refillPerSec seconds.
  // (If refillPerSec is 0 — a 0/min limit — never recover; resetAt = now + 1h.)
  const msUntilNextToken =
    refillPerSec > 0 ? Math.ceil((1 / refillPerSec) * 1000) : 60 * 60 * 1000
  return {
    allowed: false,
    remaining: 0,
    resetAt: now + msUntilNextToken,
  }
}

/**
 * Derive a rate-limit key from the request. Composite of:
 *   - the bearer token's first 10 chars (so each admin token / client token
 *     gets its own bucket; the prefix is enough to distinguish demo creds
 *     without resolving full auth — which would hit the DB on every call),
 *   - plus the source IP (x-forwarded-for[0] | x-real-ip | 'anon').
 *
 * This deliberately does NOT resolve the resolved client id (that requires a
 * DB lookup per request, defeating the point of a cheap pre-auth gate). The
 * composite means a single client behind a NAT gets one bucket, and a single
 * IP rotating across many clients gets separate buckets per (client, IP).
 */
export function getClientKey(req: Request): string {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  let tokenPrefix = 'none'
  if (authHeader) {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
    if (m) tokenPrefix = m[1].trim().slice(0, 10)
  }
  const ip = sourceIp(req) || 'anon'
  return `${tokenPrefix}|${ip}`
}
