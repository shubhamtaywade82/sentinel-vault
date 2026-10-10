// server-only — runtime environment + production-mode enforcement.
//
// Centralizes the "are we in production?" decision so every other module can
// ask `isProduction()` instead of re-checking `NODE_ENV`. Production mode is
// fail-closed: dev defaults (admin token, master key, demo endpoints) are
// refused on startup, not merely warned about.

/** True when `NODE_ENV === "production"` OR `VAULT_ENV === "production"`. */
export function isProduction(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.VAULT_ENV === 'production'
  )
}

/** True when explicitly configured as a demo/staging environment. */
export function isDemoMode(): boolean {
  if (isProduction()) return false
  return (
    process.env.VAULT_ENV === 'demo' ||
    process.env.VAULT_ENV === 'development' ||
    process.env.NODE_ENV === 'development' ||
    // default: when nothing is set we assume demo so the sandbox "just works"
    (!process.env.VAULT_ENV && !process.env.NODE_ENV)
  )
}

/**
 * Assert that a required production secret is present and not a known dev
 * default. Throws a loud, non-recoverable error on startup in production.
 *
 * Call this from module init (top-level) for `VAULT_MASTER_KEY` and
 * `VAULT_ADMIN_TOKEN`.
 */
export function assertProductionSecret(
  envVar: string,
  value: string | undefined,
  forbiddenDefaults: string[],
): void {
  if (!isProduction()) return
  // `next build` imports every route to collect page data; secrets are a
  // runtime concern, so the check re-runs when `next start` loads the module.
  if (process.env.NEXT_PHASE === 'phase-production-build') return
  if (!value || value.trim() === '') {
    throw new Error(
      `[vault][startup] ${envVar} is required in production. Refusing to start.`,
    )
  }
  for (const forbidden of forbiddenDefaults) {
    if (value === forbidden) {
      throw new Error(
        `[vault][startup] ${envVar} matches a known dev default in production. Refusing to start.`,
      )
    }
  }
}
