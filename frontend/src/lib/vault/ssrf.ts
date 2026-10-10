// server-only — SSRF guard for outbound HTTP from provider adapters.
//
// Outbound HTTP is dangerous: a misconfigured provider URL (or a malicious
// refresh_token containing an embedded URL) could trick the vault into
// fetching from internal endpoints (cloud metadata service, internal admin
// APIs, databases) and exfiltrating the response. This module enforces a
// defense-in-depth check before every outbound `fetch`:
//
//   1. Scheme must be `https:` in production. `http:` is only allowed in dev
//      so unit tests can hit `http://localhost:...` adapters.
//   2. Hostname must NOT be a known loopback/anywhere literal: `localhost`,
//      `0.0.0.0`, `[::]`.
//   3. If an `allowedHosts` allowlist is supplied, the hostname must be in it.
//   4. Resolve the hostname via `node:dns.lookup` (with `all: true` so we get
//      every A/AAAA record) and reject if ANY resolved IP is in a private
//      range: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
//      169.254.0.0/16 (link-local + cloud metadata), `::1`, `fc00::/7`
//      (unique-local IPv6).
//
// Known limitations (documented, not mitigated here):
//   - **DNS rebinding**: a hostname that resolves to a public IP at check time
//     and then to a private IP at fetch time can bypass this guard. Production
//     deployments should pair this with a pinned-IP `fetch` (re-resolve and
//     pin the IP, then connect to that IP with the original Host header) or a
//     hardened forward proxy. This file is the *basic* SSRF layer.
//   - The `allowedHosts` allowlist is the strongest mitigation: by pinning
//     outbound calls to known provider hostnames (e.g. `api.dhan.in`) an
//     attacker cannot even reach the DNS-rebinding step.
//   - IPv6 is parsed but `fetch` will still follow whatever the OS resolver
//     returns; this guard rejects the request before that fetch happens.
//
// All exports are intended for use ONLY in server-side modules (provider
// adapters, the refresh engine). Never import this from a client component.

import { lookup as dnsLookup } from 'node:dns/promises'

import { isProduction } from './env'
import { VaultError } from './errors'

export interface ValidateOutboundUrlOptions {
  /** Optional allowlist of exact hostnames. If provided the hostname must
   *  match one entry exactly (case-insensitive). This is the strongest
   *  mitigation against SSRF: an attacker cannot even reach a DNS-rebinding
   *  step. */
  allowedHosts?: string[]
}

export interface ValidationResult {
  ok: boolean
  reason?: string
}

// ---- IP classification ----------------------------------------------------
//
// We need to recognize the IPv4 private ranges and the IPv6 loopback +
// unique-local ranges. IPv4 parsing is done by hand (we don't want to pull
// in `ipaddr.js` just for this); IPv6 is normalized to a lowercase,
// non-`::`-compressed form for the prefix checks.

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const oct = parts.map((p) => parseInt(p, 10))
  if (oct.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = oct
  // 127.0.0.0/8 — loopback
  if (a === 127) return true
  // 10.0.0.0/8 — private class A
  if (a === 10) return true
  // 0.0.0.0/8 — "this network" / unspecified-as-source; treat as private
  if (a === 0) return true
  // 169.254.0.0/16 — link-local (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 — private class B
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16 — private class C
  if (a === 192 && b === 168) return true
  // 100.64.0.0/10 — CGNAT shared address space (often used internally)
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** Expand an IPv6 address to its full 8-group lowercase hex form so we can
 *  do prefix checks against `::1` and `fc00::/7` without relying on a parser
 *  library. Returns the full address (no `::` compression) or `null` if the
 *  input cannot be parsed as IPv6. */
function expandIPv6(ip: string): string | null {
  // Strip any IPv4-mapped tail (e.g. ::ffff:127.0.0.1) into its IPv6 form.
  let addr = ip.toLowerCase().trim()
  if (addr.startsWith('[') && addr.endsWith(']')) {
    addr = addr.slice(1, -1)
  }
  // IPv4-mapped (::ffff:a.b.c.d) → expand to a 128-bit hex string.
  const v4Mapped = addr.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4Mapped) {
    const octets = v4Mapped[1].split('.').map((n) => parseInt(n, 10))
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return null
    }
    const hex =
      ((octets[0] << 8) | octets[1]).toString(16).padStart(4, '0') +
      ((octets[2] << 8) | octets[3]).toString(16).padStart(4, '0')
    addr = addr.slice(0, addr.lastIndexOf(':') + 1) + hex
  }
  // Expand `::` into the right number of zero groups.
  const groups = addr.split(':')
  const emptyIdx = groups.indexOf('')
  if (emptyIdx !== -1) {
    // Two consecutive colons (e.g. "::1" → ['', '', '1']). Count actual groups
    // we have and pad with zeroes to 8.
    const nonEmpty = groups.filter((g) => g !== '').length
    const padCount = 8 - nonEmpty
    const padded: string[] = []
    for (let i = 0; i < groups.length; i++) {
      if (i === emptyIdx) {
        for (let j = 0; j < padCount; j++) padded.push('0000')
        // Skip the *second* empty slot that '::' produces.
        if (i + 1 < groups.length && groups[i + 1] === '') i++
      } else {
        padded.push(groups[i].padStart(4, '0'))
      }
    }
    groups.splice(0, groups.length, ...padded)
  }
  if (groups.length !== 8) return null
  if (groups.some((g) => !/^[0-9a-f]{4}$/.test(g))) return null
  return groups.join(':')
}

function isPrivateIPv6(ip: string): boolean {
  const full = expandIPv6(ip)
  if (!full) return false
  // ::1 — loopback
  if (full === '0000:0000:0000:0000:0000:0000:0000:0001') return true
  // :: — unspecified
  if (full === '0000:0000:0000:0000:0000:0000:0000:0000') return true
  // fc00::/7 — unique local (fc00..fdff)
  const first = full.slice(0, 4)
  const firstByte = parseInt(first, 16)
  if ((firstByte & 0xfe00) === 0xfc00) return true
  // fe80::/10 — link-local
  if ((firstByte & 0xffc0) === 0xfe80) return true
  // ::ffff:127.0.0.1 etc — IPv4-mapped; the IPv4 part is checked separately,
  // but the prefix here is ::ffff:0:0/96. We already routed IPv4-mapped
  // through isPrivateIPv4 above; just to be safe also catch the mapped
  // loopback explicitly.
  if (full.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    const tail = full.slice('0000:0000:0000:0000:0000:ffff:'.length)
    const [h1, h2] = tail.split(':')
    const a = parseInt(h1, 16) >> 8
    const b = parseInt(h1, 16) & 0xff
    if (a === 127) return true
    if (a === 10) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    void h2
  }
  return false
}

function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip)
  return isPrivateIPv4(ip)
}

// ---- URL validation -------------------------------------------------------

const BLOCKED_HOST_LITERALS = new Set([
  'localhost',
  '0.0.0.0',
  '[::]',
  '::',
  '[0000:0000:0000:0000:0000:0000:0000:0000]',
])

export function validateOutboundUrl(
  url: string,
  opts: ValidateOutboundUrlOptions = {},
): ValidationResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'malformed URL' }
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== 'https:' && scheme !== 'http:') {
    return { ok: false, reason: `unsupported scheme: ${scheme}` }
  }
  // In production we require https. In dev we allow http (so the test suite
  // can hit http://localhost:4750/... adapters without TLS).
  if (scheme === 'http:' && isProduction()) {
    return { ok: false, reason: 'http: scheme forbidden in production (use https:)' }
  }

  const rawHost = parsed.hostname.toLowerCase()
  if (!rawHost) {
    return { ok: false, reason: 'empty hostname' }
  }
  if (BLOCKED_HOST_LITERALS.has(rawHost)) {
    return { ok: false, reason: `blocked host literal: ${rawHost}` }
  }

  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const allowed = opts.allowedHosts.map((h) => h.toLowerCase())
    if (!allowed.includes(rawHost)) {
      return { ok: false, reason: `host not in allowlist: ${rawHost}` }
    }
  }

  // If the hostname is already an IP literal we can check it directly without
  // a DNS lookup.
  if (isLikelyIpLiteral(rawHost)) {
    if (isPrivateIP(rawHost)) {
      return { ok: false, reason: `IP literal resolves to a private range: ${rawHost}` }
    }
    return { ok: true }
  }

  // We can't do the DNS lookup synchronously here. The caller is expected to
  // use `boundedFetch` (which awaits) — but `validateOutboundUrl` is also
  // exported on its own as a fast pre-check. The deep DNS check lives in
  // `boundedFetch` (which is async) so this sync function returns ok=true
  // for syntactically-valid public-looking hostnames.
  return { ok: true }
}

function isLikelyIpLiteral(host: string): boolean {
  // IPv4 dotted-quad
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  // IPv6 (with or without brackets)
  if (host.startsWith('[') || host.includes(':')) return true
  return false
}

// ---- Deep (async) DNS check ----------------------------------------------

async function resolveAllIps(hostname: string): Promise<string[]> {
  // `node:dns/promises.lookup` with `all: true` returns every A/AAAA record.
  // We strip the surrounding brackets from IPv6 literals returned by URL.
  const bare = hostname.replace(/^\[/, '').replace(/\]$/, '')
  try {
    const results = await dnsLookup(bare, { all: true })
    return results.map((r) => r.address)
  } catch {
    // DNS failure → treat as no IPs (which the caller will reject).
    return []
  }
}

async function deepValidateOutboundUrl(
  url: string,
  opts: ValidateOutboundUrlOptions = {},
): Promise<ValidationResult> {
  const fast = validateOutboundUrl(url, opts)
  if (!fast.ok) return fast
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'malformed URL' }
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  // IP literals were already checked in the fast path.
  if (isLikelyIpLiteral(host)) return { ok: true }
  const ips = await resolveAllIps(host)
  if (ips.length === 0) {
    return { ok: false, reason: `DNS lookup failed for ${host}` }
  }
  for (const ip of ips) {
    if (isPrivateIP(ip)) {
      return { ok: false, reason: `${host} resolves to private IP ${ip}` }
    }
  }
  return { ok: true }
}

// ---- Bounded fetch -------------------------------------------------------

export interface BoundedFetchOptions {
  /** Hard timeout for the entire fetch (default 10_000ms). */
  timeoutMs?: number
  /** Optional hostname allowlist forwarded to the URL validator. */
  allowedHosts?: string[]
}

/** Validate `url` then `fetch(url, init)` with an `AbortController` timeout.
 *  Throws `VaultError('provider_unavailable', ...)` on SSRF rejection,
 *  abort timeout, or network error. */
export async function boundedFetch(
  url: string,
  init: RequestInit,
  opts: BoundedFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const check = await deepValidateOutboundUrl(url, { allowedHosts: opts.allowedHosts })
  if (!check.ok) {
    throw new VaultError('provider_unavailable', `SSRF guard rejected: ${check.reason}`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return res
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new VaultError(
        'provider_unavailable',
        `outbound fetch timed out after ${timeoutMs}ms: ${url}`,
      )
    }
    // Network failure → transient from the engine's perspective.
    throw new VaultError(
      'provider_unavailable',
      `outbound fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

// Exported for unit tests / advanced callers.
export const __internal = {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIP,
  expandIPv6,
  resolveAllIps,
  deepValidateOutboundUrl,
}
