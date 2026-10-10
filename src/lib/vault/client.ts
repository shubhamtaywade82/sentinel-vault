// Frontend API client for Sentinel Vault. Uses relative paths to /api/v1/*.
// The browser requests go through the Next.js dev server (port 3000) directly.
// Used by the dashboard UI. Never imports server-only code.

import type {
  AnomaliesResponse,
  AuditActivityResponse,
  AuditEventListItem,
  AuditRange,
  ClientListItem,
  ClientPreviewResponse,
  ComplianceResponse,
  ConnectionListItem,
  CreateClientResponse,
  CreateSecretResponse,
  CredentialResponse,
  DashboardStats,
  ExpiringLeasesResponse,
  GrantListItem,
  HealthResponse,
  IntegrationConnectionRow,
  IssueLeaseResponse,
  LeaseListItem,
  MeResponse,
  ProviderHealthResponse,
  RemediateResponse,
  RevealResponse,
  RotationRunRow,
  SecretAccessGrantRow,
  SecretDetail,
  SecretDiffResponse,
  SecretListItem,
  SecretUsageResponse,
  SecretVersionRow,
  ServiceClientRow,
  VaultSecretRow,
  WatchdogResponse,
  WorkspaceRow,
  WorkspaceStatus,
} from './types'

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

export type AuthMode = 'admin' | 'client'

/**
 * Returns the auth mode the API client is currently operating in.
 * - 'admin': the long-lived admin token is sent (full surface).
 * - 'client': a short-lived demo service-client credential is sent so the
 *   operator can preview the least-privilege surface from that client's POV.
 *
 * The mode is owned by the Zustand store (`useVaultStore.authMode`), but the
 * store's setClientView/exitClientView mirror it to localStorage so this
 * helper — which is read on every request — doesn't need to import React.
 */
export function getAuthMode(): AuthMode {
  if (typeof window === "undefined") return 'admin'
  return window.localStorage.getItem('sentinel.clientView') === '1'
    ? 'client'
    : 'admin'
}

function getToken(): string {
  if (typeof window === "undefined") return ''
  // Client-view mode: send the demo service-client credential so the API
  // authorizer treats the caller as that service client.
  if (getAuthMode() === 'client') {
    const clientToken = window.localStorage.getItem('sentinel.clientToken')
    if (clientToken) return clientToken
    // Fall through to admin if the client token was somehow cleared.
  }
  return window.localStorage.getItem('sentinel.adminToken') || 'vault-admin-demo-token-CHANGE-ME'
}

function workspaceQuery(workspaceId?: string | null): string {
  return workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${getToken()}`,
    ...(init.headers as Record<string, string> | undefined),
  }
  const res = await fetch(path, { ...init, headers })
  const text = await res.text()
  const body = text ? safeParse(text) : null
  if (!res.ok) {
    const err = (body as ApiError | null)?.error
    const e = new Error(err?.message || `HTTP ${res.status}`) as Error & {
      code?: string
      status?: number
      details?: Record<string, unknown>
    }
    e.code = err?.code
    e.status = res.status
    e.details = err?.details
    throw e
  }
  return body as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ---- Health ----
export const api = {
  healthLive: () => request<HealthResponse>('/api/v1/health/live'),
  healthReady: () => request<HealthResponse>('/api/v1/health/ready'),
  me: () => request<MeResponse>('/api/v1/me'),

  // ---- Workspaces ----
  listWorkspaces: () =>
    request<{ workspaces: WorkspaceRow[] }>('/api/v1/workspaces'),
  createWorkspace: (slug: string, name: string) =>
    request<{ workspace: WorkspaceRow }>('/api/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ slug, name }),
    }),

  // ---- Service clients ----
  listClients: (workspaceId: string) =>
    request<{ clients: ClientListItem[] }>(
      `/api/v1/admin/service_clients${workspaceQuery(workspaceId)}`,
    ),
  createClient: (input: {
    name: string
    clientType: string
    workspaceId: string
    expiresInDays?: number
  }) =>
    request<CreateClientResponse>('/api/v1/admin/service_clients', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  rotateClientCredential: (id: string) =>
    request<CreateClientResponse>(
      `/api/v1/admin/service_clients/${id}/rotate_credential`,
      { method: 'POST' },
    ),
  revokeClient: (id: string) =>
    request<{ client: ServiceClientRow }>(
      `/api/v1/admin/service_clients/${id}/revoke`,
      { method: 'POST' },
    ),

  // ---- Grants ----
  listGrants: (workspaceId: string) =>
    request<{ grants: GrantListItem[] }>(`/api/v1/grants${workspaceQuery(workspaceId)}`),
  createGrant: (input: {
    serviceClientId: string
    vaultSecretId: string
    permissions: string
  }) =>
    request<{ grant: SecretAccessGrantRow }>('/api/v1/admin/grants', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteGrant: (id: string) =>
    request<void>(`/api/v1/admin/grants/${id}`, { method: 'DELETE' }),

  // ---- Secrets ----
  listSecrets: (workspaceId: string) =>
    request<{ secrets: SecretListItem[] }>(
      `/api/v1/secrets${workspaceQuery(workspaceId)}`,
    ),
  getSecret: (id: string) =>
    request<{ secret: SecretDetail }>(`/api/v1/secrets/${id}`),
  createSecret: (input: {
    workspaceId: string
    path: string
    name: string
    kind: string
    classification?: string
    environment?: string
    provider?: string
    value: string
    expiresInHours?: number
  }) =>
    request<CreateSecretResponse>('/api/v1/secrets', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createVersion: (
    id: string,
    input: { value: string; expiresInHours?: number; createdByClientId?: string },
  ) =>
    request<{ version: SecretVersionRow }>(`/api/v1/secrets/${id}/versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listVersions: (id: string) =>
    request<{ versions: SecretVersionRow[] }>(`/api/v1/secrets/${id}/versions`),
  revealSecret: (id: string, reason?: string) =>
    request<RevealResponse>(
      `/api/v1/secrets/${id}/reveal?admin_reveal_ok=true`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  diffSecretVersions: (
    id: string,
    versionAId: string,
    versionBId: string,
  ) =>
    request<SecretDiffResponse>(
      `/api/v1/secrets/${id}/diff?admin_reveal_ok=true`,
      { method: 'POST', body: JSON.stringify({ versionAId, versionBId }) },
    ),
  rotateSecret: (
    id: string,
    input: { value?: string; expiresInHours?: number },
  ) =>
    request<{ version: SecretVersionRow }>(`/api/v1/secrets/${id}/rotate`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  revokeSecret: (id: string, revokeUpstream = false) =>
    request<{ secret: VaultSecretRow }>(`/api/v1/secrets/${id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ revokeUpstream }),
    }),

  // ---- Connections ----
  listConnections: (workspaceId: string) =>
    request<{ connections: ConnectionListItem[] }>(
      `/api/v1/connections${workspaceQuery(workspaceId)}`,
    ),
  createConnection: (input: {
    workspaceId: string
    providerKey: string
    authMethod: string
    adapterKey: string
    providerAccountRef?: string
    accessExpiresAt?: string
    refreshAfter?: string
    bindings: { purpose: string; secretId: string }[]
  }) =>
    request<{ connection: ConnectionListItem }>('/api/v1/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  connectionStatus: (id: string) =>
    request<{ connection: IntegrationConnectionRow }>(
      `/api/v1/connections/${id}/status`,
    ),
  refreshConnection: (id: string, idempotencyKey?: string) =>
    request<{ rotationRun: RotationRunRow }>(`/api/v1/connections/${id}/refresh`, {
      method: 'POST',
      headers: idempotencyKey
        ? { 'idempotency-key': idempotencyKey }
        : undefined,
    }),
  connectionCredential: (id: string, purpose = 'access_token') =>
    request<CredentialResponse>(`/api/v1/connections/${id}/credential`, {
      method: 'POST',
      body: JSON.stringify({ purpose }),
    }),
  reauthorizeConnection: (id: string) =>
    request<{ rotationRun: RotationRunRow }>(
      `/api/v1/connections/${id}/reauthorize`,
      { method: 'POST' },
    ),
  revokeConnection: (id: string) =>
    request<{ connection: IntegrationConnectionRow }>(
      `/api/v1/connections/${id}/revoke`,
      { method: 'POST' },
    ),

  // ---- Rotation runs ----
  listRuns: (query: { status?: string; connectionId?: string; limit?: number } = {}) =>
    request<{ runs: RotationRunRow[] }>(
      `/api/v1/rotation_runs?${new URLSearchParams(
        Object.entries(query).filter(([, v]) => v != null) as [string, string][],
      ).toString()}`,
    ),
  getRun: (id: string) =>
    request<{ run: RotationRunRow }>(`/api/v1/rotation_runs/${id}`),

  // ---- Audit ----
  listAudit: (query: {
    workspaceId?: string
    limit?: number
    offset?: number
    action?: string
    outcome?: string
  } = {}) =>
    request<{ events: AuditEventListItem[] }>(
      `/api/v1/audit_events?${new URLSearchParams(
        Object.entries(query).filter(([, v]) => v != null) as [string, string][],
      ).toString()}`,
    ),

  // ---- Leases (short-lived credential delivery) ----
  listSecretLeases: (secretId: string) =>
    request<{ leases: LeaseListItem[] }>(`/api/v1/secrets/${secretId}/leases`),
  issueLease: (
    secretId: string,
    input: { serviceClientId: string; permissions: string[]; ttlSeconds: number },
  ) =>
    request<IssueLeaseResponse>(`/api/v1/secrets/${secretId}/leases`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listAllLeases: (
    query: { activeOnly?: boolean; serviceClientId?: string; workspaceId?: string } = {},
  ) =>
    request<{ leases: LeaseListItem[] }>(
      `/api/v1/leases?${new URLSearchParams(
        Object.entries(query).filter(([, v]) => v != null) as [string, string][],
      ).toString()}`,
    ),
  revokeLease: (leaseId: string) =>
    request<{ lease: LeaseListItem }>(`/api/v1/leases/${leaseId}`, { method: 'DELETE' }),

  // ---- Per-secret activity timeline ----
  listSecretEvents: (secretId: string, limit = 50) =>
    request<{ events: AuditEventListItem[] }>(
      `/api/v1/secrets/${secretId}/events?limit=${limit}`,
    ),

  // ---- Connection recover (re-arm a reauth_required connection) ----
  recoverConnection: (id: string, input: { newRefreshToken?: string }) =>
    request<{ connection: IntegrationConnectionRow }>(
      `/api/v1/connections/${id}/recover`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  // ---- Audit CSV export (returns a Blob for download) ----
  exportAuditCsv: async (
    query: { workspaceId?: string; action?: string; outcome?: string; limit?: number } = {},
  ): Promise<Blob> => {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null) as [string, string][],
    ).toString()
    const res = await fetch(`/api/v1/audit_events/export?${qs}`, {
      headers: { authorization: `Bearer ${getToken()}` },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const e = new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`) as Error & {
        code?: string
        status?: number
      }
      e.status = res.status
      throw e
    }
    return await res.blob()
  },

  // ---- Internal (admin) ----
  runWatchdog: () =>
    request<WatchdogResponse>('/api/v1/internal/watchdog', { method: 'POST' }),
  seed: () => request<{ ok: boolean; created: Record<string, number>; credentials: Record<string, string> }>('/api/v1/internal/seed', { method: 'POST' }),
  /** Returns the demo admin token + the demo service-client credential map.
   *  Used by the "View as Client" playground so the operator doesn't have to
   *  copy-paste from a file. Admin-only. DEMO convenience — real client
   *  credentials are issued once at creation time and never re-readable. */
  listDemoCredentials: () =>
    request<{
      admin: string
      clients: Record<string, string>
    }>('/api/v1/internal/demo-credentials'),

  // ---- Dashboard ----
  dashboardStats: (workspaceId: string) =>
    request<DashboardStats>(`/api/v1/dashboard/stats${workspaceQuery(workspaceId)}`),
  providerHealth: (workspaceId: string) =>
    request<ProviderHealthResponse>(
      `/api/v1/dashboard/provider-health${workspaceQuery(workspaceId)}`,
    ),
  clientPreview: (workspaceId: string) =>
    request<ClientPreviewResponse>(
      `/api/v1/dashboard/client-preview${workspaceQuery(workspaceId)}`,
    ),
  compliance: (workspaceId: string) =>
    request<ComplianceResponse>(
      `/api/v1/dashboard/compliance${workspaceQuery(workspaceId)}`,
    ),
  expiringLeases: (workspaceId: string) =>
    request<ExpiringLeasesResponse>(
      `/api/v1/dashboard/expiring-leases${workspaceQuery(workspaceId)}`,
    ),

  // ---- Compliance drill-down / remediation ----
  auditActivity: (workspaceId: string, range: AuditRange = '24h') => {
    const qs = workspaceQuery(workspaceId)
    return request<AuditActivityResponse>(
      `/api/v1/dashboard/audit-activity${qs}${qs ? '&' : '?'}range=${range}`,
    )
  },
  remediate: (secretId: string, violation: string) =>
    request<RemediateResponse>('/api/v1/dashboard/remediate', {
      method: 'POST',
      body: JSON.stringify({ secretId, violation }),
    }),

  // ---- Dashboard: Anomalous Access Detection ----
  anomalies: (workspaceId: string, range: AuditRange = '24h') => {
    const qs = workspaceQuery(workspaceId)
    return request<AnomaliesResponse>(
      `/api/v1/dashboard/anomalies${qs}${qs ? '&' : '?'}range=${range}`,
    )
  },

  // ---- Secret usage / blast radius ----
  secretUsage: (secretId: string) =>
    request<SecretUsageResponse>(`/api/v1/secrets/${secretId}/usage`),

  // ---- OpenAPI 3.0 spec (admin-only) ----
  // Returns the full OpenAPI 3.0.0 document describing the Vault API v1 surface.
  // Generic object — no shared type needed. Used by the future Swagger UI page.
  openapiSpec: () =>
    request<Record<string, unknown>>('/api/v1/openapi.json'),
}

export type Api = typeof api
