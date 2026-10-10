// Shared contract types for Sentinel Vault.
// Imported by both the API routes (server) and the frontend (client).
// Keep field names EXACTLY aligned with prisma/schema.prisma (see VAULT_CONTRACT.md §3).

export type ClientType = 'bot' | 'app' | 'gateway' | 'cli' | 'mcp' | 'worker'
export type SecretKind =
  | 'api_key'
  | 'access_token'
  | 'refresh_token'
  | 'client_secret'
  | 'totp_seed'
  | 'private_key'
  | 'certificate'
  | 'connection_string'
  | 'public_key'
export type Classification = 'public' | 'internal' | 'confidential' | 'restricted'
export type SecretStatus = 'active' | 'rotating' | 'revoked' | 'expired' | 'retired'
export type VersionStatus = 'active' | 'retired' | 'destroyed'
export type ClientStatus = 'active' | 'revoked' | 'expired'
export type ConnectionStatus =
  | 'active'
  | 'refreshing'
  | 'reauth_required'
  | 'revoked'
  | 'error'
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type Outcome = 'success' | 'denied' | 'error'
export type WorkspaceStatus = 'active' | 'suspended' | 'archived'
export type Permission =
  | 'metadata:read'
  | 'value:read'
  | 'version:create'
  | 'rotate'
  | 'revoke'
  | 'connection:refresh'
  | 'audit:read'

export const ALL_PERMISSIONS: Permission[] = [
  'metadata:read',
  'value:read',
  'version:create',
  'rotate',
  'revoke',
  'connection:refresh',
  'audit:read',
]

export interface WorkspaceRow {
  id: string
  slug: string
  name: string
  status: WorkspaceStatus
  createdAt: string
  updatedAt: string
}

export interface ServiceClientRow {
  id: string
  workspaceId: string
  publicId: string
  name: string
  clientType: ClientType
  credentialDigest: string
  credentialPrefix: string
  status: ClientStatus
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface VaultSecretRow {
  id: string
  workspaceId: string
  path: string
  name: string
  kind: SecretKind
  classification: Classification
  environment: string
  provider: string | null
  status: SecretStatus
  expiresAt: string | null
  currentVersionId: string | null
  createdAt: string
  updatedAt: string
}

export interface SecretVersionRow {
  id: string
  vaultSecretId: string
  versionNumber: number
  status: VersionStatus
  cryptoScheme: string
  kmsKeyRef: string
  createdBy: string
  activatedAt: string
  retiredAt: string | null
  createdAt: string
}

export interface IntegrationConnectionRow {
  id: string
  workspaceId: string
  providerKey: string
  authMethod: string
  adapterKey: string
  providerAccountRef: string | null
  status: ConnectionStatus
  accessExpiresAt: string | null
  refreshAfter: string | null
  lastRefreshedAt: string | null
  refreshLeaseExpiresAt: string | null
  refreshGeneration: number
  lastErrorCode: string | null
  reauthRequiredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ConnectionBindingRow {
  id: string
  connectionId: string
  vaultSecretId: string
  purpose: string
  secretPath?: string
  secretName?: string
}

export interface SecretAccessGrantRow {
  id: string
  serviceClientId: string
  vaultSecretId: string
  permissions: string
  createdAt: string
  updatedAt: string
}

export interface RotationRunRow {
  id: string
  connectionId: string | null
  vaultSecretId: string | null
  operation: string
  status: RunStatus
  attemptCount: number
  idempotencyKey: string
  runAfter: string
  startedAt: string | null
  completedAt: string | null
  resultVersionId: string | null
  errorCode: string | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  correlationId: string | null
  createdAt: string
}

export interface SecretAccessEventRow {
  id: string
  workspaceId: string | null
  actorClientId: string | null
  vaultSecretId: string | null
  secretVersionId: string | null
  action: string
  outcome: Outcome
  reasonCode: string | null
  requestId: string | null
  sourceIp: string | null
  createdAt: string
}

// Enriched DTOs returned by the API (joined/derived fields included)

export interface SecretListItem extends VaultSecretRow {
  currentVersionNumber: number | null
  versionCount: number
}

export interface SecretDetail extends VaultSecretRow {
  versions: SecretVersionRow[]
}

export interface ConnectionListItem extends IntegrationConnectionRow {
  bindings: ConnectionBindingRow[]
}

export interface GrantListItem extends SecretAccessGrantRow {
  serviceClientName: string
  secretPath: string
  secretName: string
}

export interface AuditEventListItem extends SecretAccessEventRow {
  actorClientName: string | null
  secretPath: string | null
}

export type RotationRunListItem = RotationRunRow

export interface ClientListItem extends ServiceClientRow {
  workspaceSlug: string
  grantsCount: number
}

export interface MeResponse {
  client: {
    id: string
    publicId: string
    name: string
    clientType: ClientType
    workspaceId: string
    workspaceSlug: string
    status: ClientStatus
    permissions: string[]
  }
  grants: {
    secretId: string
    secretPath: string
    secretName: string
    permissions: string[]
  }[]
}

export interface CreateClientResponse {
  client: ServiceClientRow
  credential: string
}

export interface CreateSecretResponse {
  secret: VaultSecretRow
  version: SecretVersionRow
}

export interface RevealResponse {
  secret: VaultSecretRow
  version: SecretVersionRow
  value: string
}

export interface CredentialResponse {
  credential: {
    value: string
    expiresAt: string | null
    generation: number
    refreshed: boolean
    versionId: string
  }
}

export interface WatchdogResponse {
  checked: number
  refreshed: { connectionId: string; status: string }[]
  reauthRequired: { connectionId: string; errorCode: string | null }[]
  errors: { connectionId: string; errorCode: string | null }[]
}

export interface SeedResponse {
  ok: boolean
  created: Record<string, number>
  credentials: Record<string, string>
}

export interface HealthResponse {
  status: string
  ts: string
  db?: string
  crypto?: string
}

export interface DashboardStats {
  totalSecrets: number
  activeConnections: number
  pendingRotations: number
  reauthRequired: number
  auditEvents24h: number
  activeClients: number
  totalClients: number
  totalWorkspaces: number
  expiringSoon: {
    id: string
    kind: 'connection' | 'secret'
    ref: string
    expiresAt: string
    status: string
  }[]
}

// ---- Secret leases (short-lived credential delivery) ---------------------
// SecretLeaseRow matches prisma `SecretLease` (all Date fields serialized to
// ISO strings on the API boundary). See `src/lib/vault/leases.ts`.
export interface SecretLeaseRow {
  id: string
  vaultSecretId: string
  serviceClientId: string
  grantedPermissions: string
  issuedAt: string
  expiresAt: string
  revokedAt: string | null
  status: 'active' | 'revoked' | 'expired'
  createdAt: string
}

export interface LeaseListItem extends SecretLeaseRow {
  secretPath: string
  serviceClientName: string
}

export interface IssueLeaseResponse {
  lease: LeaseListItem
}

export interface SecretDiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
  aLine?: number
  bLine?: number
}

export interface SecretDiffResponse {
  versionA: SecretVersionRow
  versionB: SecretVersionRow
  valueA: string
  valueB: string
  diff: SecretDiffLine[]
  stats: {
    additions: number
    removals: number
    context: number
  }
}

// ---- Dashboard: Provider Health aggregation ------------------------------
// Aggregated health metrics per unique (providerKey, adapterKey) combination
// in a workspace. Powers the "Provider Health" dashboard panel.
// See `src/app/api/v1/dashboard/provider-health/route.ts`.
export interface ProviderHealthRow {
  providerKey: string
  adapterKey: string
  totalConnections: number
  activeConnections: number
  reauthRequired: number
  totalRefreshes: number
  successfulRefreshes: number
  failedRefreshes: number
  successRate: number
  lastRefreshAt: string | null
  avgRefreshMs: number | null
}

export interface ProviderHealthResponse {
  providers: ProviderHealthRow[]
}

// ---- Dashboard: Client Preview (least-privilege proof) ------------------
// Per-service-client view of which secrets it can/cannot access. Powers the
// "Client Preview" dashboard panel demonstrating the least-privilege model.
// See `src/app/api/v1/dashboard/client-preview/route.ts`.
export interface ClientPreviewSecret {
  secretId: string
  path: string
  name: string
  kind: string
  permissions?: string[]
}

export interface ClientPreviewRow {
  clientId: string
  clientName: string
  clientType: string
  publicId: string
  status: string
  grantsCount: number
  accessibleSecrets: ClientPreviewSecret[]
  inaccessibleSecrets: ClientPreviewSecret[]
}

export interface ClientPreviewResponse {
  clients: ClientPreviewRow[]
}

// ---- Dashboard: Policy & Rotation Compliance ----------------------------
// Aggregates per-secret rotation-policy violations across a workspace.
// Powers the "Compliance" dashboard panel.
// See `src/app/api/v1/dashboard/compliance/route.ts`.
export interface ComplianceViolation {
  secretId: string
  path: string
  kind: string
  violation: 'stale_rotation' | 'never_rotated' | 'expired_secret' | 'expiring_soon'
  daysStale: number
  lastRotatedAt: string | null
  expiresAt: string | null
}

export interface ComplianceResponse {
  summary: {
    totalSecrets: number
    compliant: number
    violations: number
    complianceScore: number
  }
  violations: ComplianceViolation[]
}

// ---- Dashboard: Expiring Leases widget ------------------------------------
// Active (and stale-active) SecretLease rows expiring within the next hour.
// Powers the "Expiring Leases" dashboard panel.
// See `src/app/api/v1/dashboard/expiring-leases/route.ts`.
export interface ExpiringLeaseRow {
  leaseId: string
  secretPath: string
  secretName: string
  clientName: string
  expiresAt: string
  secondsRemaining: number
  status: 'expiring' | 'expired'
}

export interface ExpiringLeasesResponse {
  leases: ExpiringLeaseRow[]
}

// ---- Dashboard: Audit Activity (time-bucketed audit event counts) ---------
// Aggregates SecretAccessEvent rows in a time range into fixed-width buckets.
// Powers the "Audit Activity" compliance drill-down panel.
// See `src/app/api/v1/dashboard/audit-activity/route.ts`.
export type AuditRange = '1h' | '24h' | '7d' | '30d'

export interface AuditActivityBucket {
  ts: string
  count: number
}

export interface AuditActivityResponse {
  range: AuditRange
  buckets: AuditActivityBucket[]
  totals: {
    events: number
    reveals: number
    rotations: number
    denied: number
  }
}

// ---- Dashboard: Remediate (one-click compliance remediation) --------------
// Generates a new version of a violating secret (admin-only, demo flow) and
// records a `secret.remediate` audit event with `reasonCode = violation`.
// See `src/app/api/v1/dashboard/remediate/route.ts`.
export interface RemediateResponse {
  secret: VaultSecretRow
  version: SecretVersionRow
  remediated: string
}

// ---- Dashboard: Anomalous Access Detection ---------------------------------
// Analyzes SecretAccessEvent rows in a time range for anomalous patterns:
// denied spikes, new source IPs, off-hours access, access bursts, and
// cross-workspace access attempts. Powers the "Anomalies" dashboard panel.
// See `src/app/api/v1/dashboard/anomalies/route.ts`.
export interface AnomalyRow {
  id: string
  type: 'denied_spike' | 'new_ip' | 'off_hours' | 'burst' | 'cross_workspace_attempt'
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  secretPath: string | null
  actorName: string | null
  sourceIp: string | null
  ts: string
  metadata: Record<string, unknown>
}

export interface AnomaliesResponse {
  anomalies: AnomalyRow[]
}

// ---- Secret Usage / Blast Radius -------------------------------------------
// "What breaks if this secret is revoked?" — collects every dependent
// ServiceClient (via grants), every IntegrationConnection (via bindings),
// and every SecretLease (any status) attached to a secret, plus a summary
// count of distinct clients/connections/active-leases.
// See `src/app/api/v1/secrets/[id]/usage/route.ts`.
export interface SecretUsageGrant {
  clientId: string
  clientName: string
  clientType: string
  permissions: string[]
  lastUsedAt: string | null
}

export interface SecretUsageConnection {
  connectionId: string
  providerKey: string
  adapterKey: string
  status: string
  purpose: string
  providerAccountRef: string | null
}

export interface SecretUsageLease {
  leaseId: string
  clientName: string
  expiresAt: string
  status: string
}

export interface SecretUsageResponse {
  secretId: string
  path: string
  usage: {
    grants: SecretUsageGrant[]
    connections: SecretUsageConnection[]
    leases: SecretUsageLease[]
  }
  blastRadius: {
    clientCount: number
    connectionCount: number
    activeLeaseCount: number
  }
}
