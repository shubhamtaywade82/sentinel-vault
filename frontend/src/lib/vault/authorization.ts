// server-only — grant-based authorization.
// See VAULT_CONTRACT.md §2 (client realm) and §10 (grant_required).

import { db } from '@/lib/db'
import { VaultError } from './errors'
import { ALL_PERMISSIONS, type Permission } from './types'

/**
 * Parse a comma-separated permissions string into a normalized Permission[].
 * Unknown / misspelled entries are dropped silently (defensive parse).
 */
export function parsePermissions(permissions: string): Permission[] {
  if (!permissions) return []
  const set = new Set<Permission>()
  for (const raw of permissions.split(',')) {
    const p = raw.trim() as Permission
    if ((ALL_PERMISSIONS as string[]).includes(p)) set.add(p)
  }
  return Array.from(set)
}

/** Serialize a Permission[] back into the canonical comma-separated form. */
export function serializePermissions(perms: Permission[]): string {
  // Stable order — same as defined in ALL_PERMISSIONS — so stored strings diff cleanly.
  return (ALL_PERMISSIONS as Permission[])
    .filter((p) => perms.includes(p))
    .join(',')
}

/** True if `permissions` (comma-separated string) contains `perm`. */
export function hasPermission(permissions: string, perm: Permission): boolean {
  return parsePermissions(permissions).includes(perm)
}

/**
 * Returns true iff a SecretAccessGrant exists for (serviceClientId, vaultSecretId)
 * whose permissions field contains `permission`.
 */
export async function checkGrant(
  serviceClientId: string,
  vaultSecretId: string,
  permission: Permission,
): Promise<boolean> {
  const grant = await db.secretAccessGrant.findFirst({
    where: { serviceClientId, vaultSecretId },
    select: { permissions: true },
  })
  if (!grant) return false
  return hasPermission(grant.permissions, permission)
}

/**
 * Throws `grant_required` (403) with a human-readable message naming the
 * missing permission and the secret id when the principal lacks `permission`.
 */
export async function requireGrant(
  serviceClientId: string,
  vaultSecretId: string,
  permission: Permission,
): Promise<void> {
  const ok = await checkGrant(serviceClientId, vaultSecretId, permission)
  if (!ok) {
    throw new VaultError(
      'grant_required',
      `Missing grant: ${permission} on ${vaultSecretId}`,
    )
  }
}

export { VaultError }
