// GET /api/v1/openapi.json → 200 application/json
// Admin-only. Returns a static OpenAPI 3.0.0 document describing the Vault API
// v1 surface (~50 operations across 12 tags). The spec is built once as a
// module-level constant so the per-request cost is just `JSON.stringify`.
// Audits `openapi.read` (fire-and-forget — audit failures never break the read).
//
// NOTE on file location: Next.js App Router maps route file paths to URLs
// literally, so to serve `/api/v1/openapi.json` the folder MUST be named
// `openapi.json`. See VAULT_CONTRACT.md §4 + R11 worklog entry.
import { handle, json, adminOrThrow, getRequestId, getSourceIp } from '@/lib/vault/api-helpers'
import { emitAuditEvent } from '@/lib/vault/audit'

// ---- Small response builders --------------------------------------------
// OpenAPI 3.0 response objects need at minimum a `description`. We bundle the
// standard error envelope variants here so each operation stays readable.

type ResponseObj = { description: string; content?: Record<string, { schema?: unknown }> }

function jsonBody(schemaRef: string): Record<string, { schema: unknown }> {
  return { 'application/json': { schema: { $ref: `#/components/schemas/${schemaRef}` } } }
}

function ok(description: string, schemaRef?: string): ResponseObj {
  return schemaRef
    ? { description, content: jsonBody(schemaRef) }
    : { description }
}

const ERR_400 = { description: 'Bad request — malformed JSON body or invalid path param.' }
const ERR_401 = { description: 'Unauthorized — missing or invalid bearer token.' }
const ERR_403 = { description: 'Forbidden — admin realm required, or grant missing.' }
const ERR_404 = { description: 'Not found — resource does not exist or is outside the caller workspace.' }
const ERR_409 = { description: 'Conflict — duplicate path, rotation already in progress, or stale generation.' }
const ERR_422 = { description: 'Unprocessable entity — validation_failed or business rule violation.' }
const ERR_500 = { description: 'Internal server error — see server logs.' }

type Param = {
  name: string
  in: 'path' | 'query' | 'header'
  required?: boolean
  description: string
  schema: Record<string, unknown>
}

function pathParam(name: string, description: string): Param {
  return {
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' },
  }
}

function queryParam(
  name: string,
  description: string,
  opts: { required?: boolean; type?: 'string' | 'integer'; enum?: string[] } = {},
): Param {
  const schema: Record<string, unknown> = { type: opts.type ?? 'string' }
  if (opts.enum) schema.enum = opts.enum
  if (opts.type === 'integer') schema.format = 'int64'
  return {
    name,
    in: 'query',
    required: opts.required ?? false,
    description,
    schema,
  }
}

function headerParam(name: string, description: string): Param {
  return {
    name,
    in: 'header',
    required: false,
    description,
    schema: { type: 'string' },
  }
}

function requestBody(description: string, schemaRef: string, required = true) {
  return {
    description,
    required,
    content: jsonBody(schemaRef),
  }
}

// ---- The OpenAPI 3.0.0 document ------------------------------------------

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Sentinel Vault API',
    version: '1.0.0',
    description:
      'Workspace-isolated, encrypted, versioned secret storage with per-client authorization, KMS-style envelope encryption, and durable credential refresh.',
    contact: { name: 'Sentinel Vault', url: '/api/v1/health/live' },
    license: { name: 'Proprietary' },
  },
  servers: [{ url: '/api/v1', description: 'Vault API v1' }],
  tags: [
    { name: 'Health', description: 'Liveness / readiness probes.' },
    { name: 'Identity', description: 'Caller identity introspection.' },
    { name: 'Workspaces', description: 'Workspace lifecycle.' },
    { name: 'Service Clients', description: 'Service-client CRUD + credential rotation.' },
    { name: 'Grants', description: 'Per-secret permission grants.' },
    { name: 'Secrets', description: 'Encrypted secret + version lifecycle.' },
    { name: 'Connections', description: 'Integration connections + OAuth refresh.' },
    { name: 'Rotation Runs', description: 'Async rotation / refresh run inspection.' },
    { name: 'Audit', description: 'Append-only audit-event query + CSV export.' },
    { name: 'Leases', description: 'Short-lived credential delivery leases.' },
    { name: 'Internal', description: 'Admin-only operational helpers (watchdog, seed, demo).' },
    { name: 'Dashboard', description: 'Aggregated dashboard / compliance views.' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'validation_failed' },
              message: { type: 'string', example: 'value is required' },
              details: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      Workspace: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          slug: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['active', 'suspended', 'archived'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ServiceClient: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspaceId: { type: 'string' },
          publicId: { type: 'string' },
          name: { type: 'string' },
          clientType: { type: 'string', enum: ['bot', 'app', 'gateway', 'cli', 'mcp', 'worker'] },
          credentialDigest: { type: 'string' },
          credentialPrefix: { type: 'string' },
          status: { type: 'string', enum: ['active', 'revoked', 'expired'] },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          revokedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Secret: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspaceId: { type: 'string' },
          path: { type: 'string', example: 'payments/stripe/live' },
          name: { type: 'string' },
          kind: {
            type: 'string',
            enum: [
              'api_key', 'access_token', 'refresh_token', 'client_secret',
              'totp_seed', 'private_key', 'certificate', 'connection_string', 'public_key',
            ],
          },
          classification: {
            type: 'string',
            enum: ['public', 'internal', 'confidential', 'restricted'],
          },
          environment: { type: 'string' },
          provider: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['active', 'rotating', 'revoked', 'expired', 'retired'],
          },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          currentVersionId: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      SecretVersion: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          vaultSecretId: { type: 'string' },
          versionNumber: { type: 'integer' },
          status: { type: 'string', enum: ['active', 'retired', 'destroyed'] },
          cryptoScheme: { type: 'string' },
          kmsKeyRef: { type: 'string' },
          createdBy: { type: 'string' },
          activatedAt: { type: 'string', format: 'date-time' },
          retiredAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Connection: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspaceId: { type: 'string' },
          providerKey: { type: 'string' },
          authMethod: { type: 'string' },
          adapterKey: { type: 'string' },
          providerAccountRef: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: ['active', 'refreshing', 'reauth_required', 'revoked', 'error'],
          },
          accessExpiresAt: { type: 'string', format: 'date-time', nullable: true },
          refreshAfter: { type: 'string', format: 'date-time', nullable: true },
          lastRefreshedAt: { type: 'string', format: 'date-time', nullable: true },
          refreshLeaseExpiresAt: { type: 'string', format: 'date-time', nullable: true },
          refreshGeneration: { type: 'integer' },
          lastErrorCode: { type: 'string', nullable: true },
          reauthRequiredAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      RotationRun: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          connectionId: { type: 'string', nullable: true },
          vaultSecretId: { type: 'string', nullable: true },
          operation: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'succeeded', 'failed', 'cancelled'],
          },
          attemptCount: { type: 'integer' },
          idempotencyKey: { type: 'string' },
          runAfter: { type: 'string', format: 'date-time' },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          resultVersionId: { type: 'string', nullable: true },
          errorCode: { type: 'string', nullable: true },
          leaseToken: { type: 'string', nullable: true },
          leaseExpiresAt: { type: 'string', format: 'date-time', nullable: true },
          correlationId: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AuditEvent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          workspaceId: { type: 'string', nullable: true },
          actorClientId: { type: 'string', nullable: true },
          vaultSecretId: { type: 'string', nullable: true },
          secretVersionId: { type: 'string', nullable: true },
          action: { type: 'string', example: 'secret.reveal' },
          outcome: { type: 'string', enum: ['success', 'denied', 'error'] },
          reasonCode: { type: 'string', nullable: true },
          requestId: { type: 'string', nullable: true },
          sourceIp: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Lease: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          vaultSecretId: { type: 'string' },
          serviceClientId: { type: 'string' },
          grantedPermissions: { type: 'string' },
          issuedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          revokedAt: { type: 'string', format: 'date-time', nullable: true },
          status: { type: 'string', enum: ['active', 'revoked', 'expired'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Grant: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          serviceClientId: { type: 'string' },
          vaultSecretId: { type: 'string' },
          permissions: { type: 'string', example: 'metadata:read,value:read' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'alive' },
          ts: { type: 'string', format: 'date-time' },
          db: { type: 'string' },
          crypto: { type: 'string' },
        },
      },
      DashboardStats: {
        type: 'object',
        properties: {
          totalSecrets: { type: 'integer' },
          activeConnections: { type: 'integer' },
          pendingRotations: { type: 'integer' },
          reauthRequired: { type: 'integer' },
          auditEvents24h: { type: 'integer' },
          activeClients: { type: 'integer' },
          totalClients: { type: 'integer' },
          totalWorkspaces: { type: 'integer' },
          expiringSoon: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string', enum: ['connection', 'secret'] },
                ref: { type: 'string' },
                expiresAt: { type: 'string', format: 'date-time' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    // ---- Health ----
    '/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Returns `{ status: "alive" }`. No DB or crypto check — used by load balancers.',
        operationId: 'healthLive',
        security: [],
        responses: {
          '200': ok('Server is alive.', 'HealthResponse'),
          '500': ERR_500,
        },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description:
          'Returns `{ status: "ready", db, crypto }`. Verifies the SQLite DB is reachable and the crypto subsystem is initialised.',
        operationId: 'healthReady',
        security: [],
        responses: {
          '200': ok('Server is ready.', 'HealthResponse'),
          '503': { description: 'Service unavailable — DB or crypto subsystem not ready.' },
        },
      },
    },

    // ---- Identity ----
    '/me': {
      get: {
        tags: ['Identity'],
        summary: 'Resolve the current caller',
        description:
          'Returns the calling service client (or admin) and the list of grants the caller has. Used by the UI "View as Client" playground.',
        operationId: 'getMe',
        responses: {
          '200': ok('Caller identity + grants.', 'ServiceClient'),
          '401': ERR_401,
          '500': ERR_500,
        },
      },
    },

    // ---- Workspaces ----
    '/workspaces': {
      get: {
        tags: ['Workspaces'],
        summary: 'List workspaces',
        description: 'Admin: returns all workspaces. Client: returns the caller workspace only.',
        operationId: 'listWorkspaces',
        responses: {
          '200': ok('List of workspaces.', 'Workspace'),
          '401': ERR_401,
          '500': ERR_500,
        },
      },
      post: {
        tags: ['Workspaces'],
        summary: 'Create a workspace',
        description: 'Admin only. Creates a new workspace with a unique slug.',
        operationId: 'createWorkspace',
        requestBody: requestBody('Workspace definition.', 'Workspace'),
        responses: {
          '201': ok('Workspace created.', 'Workspace'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '409': ERR_409,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },

    // ---- Service Clients ----
    '/admin/service_clients': {
      get: {
        tags: ['Service Clients'],
        summary: 'List service clients',
        description: 'Admin only. Optional `?workspaceId=` filter.',
        operationId: 'listServiceClients',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID.')],
        responses: {
          '200': ok('List of service clients.', 'ServiceClient'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
      post: {
        tags: ['Service Clients'],
        summary: 'Create a service client',
        description:
          'Admin only. Issues a one-time-readable credential. The plaintext credential is returned in this response ONLY — store it immediately.',
        operationId: 'createServiceClient',
        requestBody: requestBody('Client definition.', 'ServiceClient'),
        responses: {
          '201': ok('Client created with one-time credential.', 'ServiceClient'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/admin/service_clients/{id}/rotate_credential': {
      post: {
        tags: ['Service Clients'],
        summary: 'Rotate a service client credential',
        description:
          'Admin only. Issues a new credential, invalidating the previous one. The new plaintext credential is returned once.',
        operationId: 'rotateServiceClientCredential',
        parameters: [pathParam('id', 'Service client ID.')],
        responses: {
          '200': ok('New credential issued.', 'ServiceClient'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },
    '/admin/service_clients/{id}/revoke': {
      post: {
        tags: ['Service Clients'],
        summary: 'Revoke a service client',
        description:
          'Admin only. Marks the client `revoked`; all its grants remain but no longer authorise.',
        operationId: 'revokeServiceClient',
        parameters: [pathParam('id', 'Service client ID.')],
        responses: {
          '200': ok('Client revoked.', 'ServiceClient'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '409': ERR_409,
          '500': ERR_500,
        },
      },
    },

    // ---- Grants ----
    '/grants': {
      get: {
        tags: ['Grants'],
        summary: 'List grants',
        description:
          'Admin: all grants (optionally filtered by `?workspaceId=`). Client: grants owned by the caller.',
        operationId: 'listGrants',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID.')],
        responses: {
          '200': ok('List of grants.', 'Grant'),
          '401': ERR_401,
          '500': ERR_500,
        },
      },
    },
    '/admin/grants': {
      post: {
        tags: ['Grants'],
        summary: 'Create a grant',
        description:
          'Admin only. Binds a service client to a secret with a permission set (comma-separated `metadata:read,value:read,...`).',
        operationId: 'createGrant',
        requestBody: requestBody('Grant definition.', 'Grant'),
        responses: {
          '201': ok('Grant created.', 'Grant'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/admin/grants/{id}': {
      delete: {
        tags: ['Grants'],
        summary: 'Delete a grant',
        description:
          'Admin only. Removes the grant; subsequent access checks against that client/secret pair will fail.',
        operationId: 'deleteGrant',
        parameters: [pathParam('id', 'Grant ID.')],
        responses: {
          '204': { description: 'Grant deleted (no content).' },
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },

    // ---- Secrets ----
    '/secrets': {
      get: {
        tags: ['Secrets'],
        summary: 'List secrets',
        description:
          'Admin: all secrets (optionally filtered by `?workspaceId=`). Client: only secrets in the caller workspace with at least one grant.',
        operationId: 'listSecrets',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID (admin only).')],
        responses: {
          '200': ok('List of secrets.', 'Secret'),
          '401': ERR_401,
          '500': ERR_500,
        },
      },
      post: {
        tags: ['Secrets'],
        summary: 'Create a secret + first version',
        description:
          'Admin only. Atomically creates the secret row + its first encrypted version (envelope-encrypted with AAD = workspaceId + secretId + versionNumber).',
        operationId: 'createSecret',
        requestBody: requestBody('Secret + value definition.', 'Secret'),
        responses: {
          '201': ok('Secret + first version created.', 'SecretVersion'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '409': ERR_409,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}': {
      get: {
        tags: ['Secrets'],
        summary: 'Get a secret (metadata + version history)',
        description:
          'Admin: any secret. Client: secrets in the caller workspace the client has at least `metadata:read` on.',
        operationId: 'getSecret',
        parameters: [pathParam('id', 'Secret ID.')],
        responses: {
          '200': ok('Secret detail with versions array.', 'Secret'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/versions': {
      get: {
        tags: ['Secrets'],
        summary: 'List versions of a secret',
        operationId: 'listSecretVersions',
        parameters: [pathParam('id', 'Secret ID.')],
        responses: {
          '200': ok('List of secret versions.', 'SecretVersion'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
      post: {
        tags: ['Secrets'],
        summary: 'Create a new version of a secret',
        description:
          'Admin only. Encrypts the new value, marks the previous active version `retired`, and points `currentVersionId` at the new version.',
        operationId: 'createSecretVersion',
        parameters: [pathParam('id', 'Secret ID.')],
        requestBody: requestBody('Version payload (plaintext value).', 'SecretVersion'),
        responses: {
          '201': ok('New version created and activated.', 'SecretVersion'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '409': ERR_409,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/reveal': {
      post: {
        tags: ['Secrets'],
        summary: 'Reveal (decrypt) the current secret value',
        description:
          'Admin: requires `?admin_reveal_ok=true` (UI confirm flow). Client: requires `value:read` grant. Response is `cache-control: no-store`. Audits `secret.reveal` with success/denied outcome.',
        operationId: 'revealSecret',
        parameters: [
          pathParam('id', 'Secret ID.'),
          queryParam('admin_reveal_ok', 'Must be "true" for admin reveals.', {
            enum: ['true', 'false'],
          }),
        ],
        requestBody: {
          description: 'Optional. May include `reason` for the audit trail.',
          required: false,
          content: jsonBody('SecretVersion'),
        },
        responses: {
          '200': ok('Decrypted value + secret + version metadata. Never cached.', 'SecretVersion'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/rotate': {
      post: {
        tags: ['Secrets'],
        summary: 'Rotate a secret value',
        description:
          'Admin only, OR client with `rotate` grant. Generates a new version (using a caller-supplied or generated value), retires the previous, and records `secret.rotate`.',
        operationId: 'rotateSecret',
        parameters: [pathParam('id', 'Secret ID.')],
        requestBody: requestBody('Optional new value + expiry.', 'SecretVersion'),
        responses: {
          '200': ok('New version created and activated.', 'SecretVersion'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '409': ERR_409,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/revoke': {
      post: {
        tags: ['Secrets'],
        summary: 'Revoke a secret',
        description:
          'Admin only. Marks the secret `revoked`. Optionally `revokeUpstream: true` cascades to bound connections.',
        operationId: 'revokeSecret',
        parameters: [pathParam('id', 'Secret ID.')],
        requestBody: requestBody('Revoke options.', 'Secret'),
        responses: {
          '200': ok('Secret revoked.', 'Secret'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '409': ERR_409,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/diff': {
      post: {
        tags: ['Secrets'],
        summary: 'Diff two versions of a secret',
        description:
          'Admin: requires `?admin_reveal_ok=true`. Client: requires `value:read`. Returns decrypted values + a line-by-line diff.',
        operationId: 'diffSecretVersions',
        parameters: [
          pathParam('id', 'Secret ID.'),
          queryParam('admin_reveal_ok', 'Must be "true" for admin diffs.', {
            enum: ['true', 'false'],
          }),
        ],
        requestBody: requestBody('Version IDs to diff.', 'SecretVersion'),
        responses: {
          '200': ok('Diff result with additions/removals/context counts.', 'SecretVersion'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/events': {
      get: {
        tags: ['Secrets', 'Audit'],
        summary: 'List audit events for a secret',
        operationId: 'listSecretEvents',
        parameters: [
          pathParam('id', 'Secret ID.'),
          queryParam('limit', 'Max events to return.', { type: 'integer' }),
        ],
        responses: {
          '200': ok('Audit events scoped to this secret.', 'AuditEvent'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/usage': {
      get: {
        tags: ['Secrets'],
        summary: 'Blast-radius / usage for a secret',
        description:
          'Returns every grant, every bound connection, and every lease attached to the secret — i.e. "what breaks if this secret is revoked?"',
        operationId: 'getSecretUsage',
        parameters: [pathParam('id', 'Secret ID.')],
        responses: {
          '200': ok('Usage summary with blast-radius counts.', 'Secret'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },
    '/secrets/{id}/leases': {
      get: {
        tags: ['Secrets', 'Leases'],
        summary: 'List leases for a secret',
        operationId: 'listSecretLeases',
        parameters: [pathParam('id', 'Secret ID.')],
        responses: {
          '200': ok('List of leases for this secret.', 'Lease'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
      post: {
        tags: ['Secrets', 'Leases'],
        summary: 'Issue a short-lived lease',
        description:
          'Admin only (demo flow). Issues a short-lived lease that allows the named service client to read the secret value until `expiresAt`.',
        operationId: 'issueSecretLease',
        parameters: [pathParam('id', 'Secret ID.')],
        requestBody: requestBody('Lease request (client + permissions + TTL).', 'Lease'),
        responses: {
          '201': ok('Lease issued.', 'Lease'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },

    // ---- Connections ----
    '/connections': {
      get: {
        tags: ['Connections'],
        summary: 'List connections',
        description:
          'Admin: all connections (optionally filtered). Client: connections in the caller workspace.',
        operationId: 'listConnections',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID (admin only).')],
        responses: {
          '200': ok('List of connections.', 'Connection'),
          '401': ERR_401,
          '500': ERR_500,
        },
      },
      post: {
        tags: ['Connections'],
        summary: 'Create a connection',
        description:
          'Admin only. Creates an integration connection with optional bindings to existing secrets.',
        operationId: 'createConnection',
        requestBody: requestBody('Connection definition + bindings.', 'Connection'),
        responses: {
          '201': ok('Connection created.', 'Connection'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/connections/{id}/status': {
      get: {
        tags: ['Connections'],
        summary: 'Get connection status',
        description:
          'Returns the connection row (status, refreshGeneration, lastErrorCode, etc.).',
        operationId: 'getConnectionStatus',
        parameters: [pathParam('id', 'Connection ID.')],
        responses: {
          '200': ok('Connection status.', 'Connection'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },
    '/connections/{id}/refresh': {
      post: {
        tags: ['Connections'],
        summary: 'Refresh a connection',
        description:
          'Admin, OR client with `connection:refresh` grant on a bound secret. Returns 202 with the rotation run. Supports `Idempotency-Key` header for safe retries.',
        operationId: 'refreshConnection',
        parameters: [
          pathParam('id', 'Connection ID.'),
          headerParam('Idempotency-Key', 'Optional idempotency key — same key returns the prior run.'),
        ],
        responses: {
          '202': ok('Refresh run accepted.', 'RotationRun'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '409': ERR_409,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/connections/{id}/credential': {
      post: {
        tags: ['Connections'],
        summary: 'Materialize a credential from a connection',
        description:
          'Admin, OR client with `value:read` on a bound secret. Returns a one-time-use credential envelope (value + expiry + generation).',
        operationId: 'connectionCredential',
        parameters: [pathParam('id', 'Connection ID.')],
        requestBody: requestBody('Purpose label (e.g. access_token).', 'Connection'),
        responses: {
          '200': ok('Credential envelope.', 'Connection'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/connections/{id}/reauthorize': {
      post: {
        tags: ['Connections'],
        summary: 'Trigger reauthorization',
        description:
          'Admin only. Schedules a reauth rotation run (e.g. when the provider has issued a new refresh token out-of-band).',
        operationId: 'reauthorizeConnection',
        parameters: [pathParam('id', 'Connection ID.')],
        responses: {
          '202': ok('Reauth run accepted.', 'RotationRun'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
    '/connections/{id}/revoke': {
      post: {
        tags: ['Connections'],
        summary: 'Revoke a connection',
        description:
          'Admin only. Marks the connection `revoked`; subsequent refreshes are rejected.',
        operationId: 'revokeConnection',
        parameters: [pathParam('id', 'Connection ID.')],
        responses: {
          '200': ok('Connection revoked.', 'Connection'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '409': ERR_409,
          '500': ERR_500,
        },
      },
    },
    '/connections/{id}/recover': {
      post: {
        tags: ['Connections'],
        summary: 'Recover a reauth_required connection',
        description:
          'Admin only. Arms a connection that landed in `reauth_required` with a fresh refresh token (demo flow).',
        operationId: 'recoverConnection',
        parameters: [pathParam('id', 'Connection ID.')],
        requestBody: requestBody('New refresh token (optional).', 'Connection'),
        responses: {
          '200': ok('Connection recovered.', 'Connection'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },

    // ---- Rotation Runs ----
    '/rotation_runs': {
      get: {
        tags: ['Rotation Runs'],
        summary: 'List rotation runs',
        description: 'Admin only. Optional filters: `?status=`, `?connectionId=`, `?limit=`.',
        operationId: 'listRotationRuns',
        parameters: [
          queryParam('status', 'Filter by run status.', {
            enum: ['pending', 'running', 'succeeded', 'failed', 'cancelled'],
          }),
          queryParam('connectionId', 'Filter by connection ID.'),
          queryParam('limit', 'Max runs to return.', { type: 'integer' }),
        ],
        responses: {
          '200': ok('List of rotation runs.', 'RotationRun'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/rotation_runs/{id}': {
      get: {
        tags: ['Rotation Runs'],
        summary: 'Get a rotation run',
        operationId: 'getRotationRun',
        parameters: [pathParam('id', 'Run ID.')],
        responses: {
          '200': ok('Rotation run detail.', 'RotationRun'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },

    // ---- Audit ----
    '/audit_events': {
      get: {
        tags: ['Audit'],
        summary: 'List audit events',
        description:
          'Admin: all events (optionally filtered). Client: events in the caller workspace. Supports `?workspaceId=`, `?action=`, `?outcome=`, `?limit=`, `?offset=`.',
        operationId: 'listAuditEvents',
        parameters: [
          queryParam('workspaceId', 'Filter by workspace ID.'),
          queryParam('action', 'Filter by action prefix (e.g. `secret.reveal`).'),
          queryParam('outcome', 'Filter by outcome.', { enum: ['success', 'denied', 'error'] }),
          queryParam('limit', 'Max events to return.', { type: 'integer' }),
          queryParam('offset', 'Pagination offset.', { type: 'integer' }),
        ],
        responses: {
          '200': ok('List of audit events.', 'AuditEvent'),
          '401': ERR_401,
          '500': ERR_500,
        },
      },
    },
    '/audit_events/export': {
      get: {
        tags: ['Audit'],
        summary: 'Export audit events as CSV',
        description:
          'Admin only. Returns `text/csv` (RFC 4180). Columns: id,createdAt,actor,action,resource,outcome,reasonCode,requestId,sourceIp,workspaceId. NO secret values.',
        operationId: 'exportAuditEventsCsv',
        parameters: [
          queryParam('workspaceId', 'Filter by workspace ID.'),
          queryParam('action', 'Filter by action prefix.'),
          queryParam('outcome', 'Filter by outcome.', { enum: ['success', 'denied', 'error'] }),
          queryParam('limit', 'Max rows (capped at 10000).', { type: 'integer' }),
        ],
        responses: {
          '200': {
            description: 'CSV file download (`content-disposition: attachment`).',
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },

    // ---- Leases ----
    '/leases': {
      get: {
        tags: ['Leases'],
        summary: 'List all leases',
        description:
          'Admin only. Optional filters: `?activeOnly=`, `?serviceClientId=`, `?workspaceId=`.',
        operationId: 'listLeases',
        parameters: [
          queryParam('activeOnly', 'If "true", return only active leases.', {
            enum: ['true', 'false'],
          }),
          queryParam('serviceClientId', 'Filter by service client ID.'),
          queryParam('workspaceId', 'Filter by workspace ID.'),
        ],
        responses: {
          '200': ok('List of leases.', 'Lease'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/leases/{id}': {
      delete: {
        tags: ['Leases'],
        summary: 'Revoke a lease',
        description:
          'Admin only. Marks the lease `revoked`; subsequent reads against it fail.',
        operationId: 'revokeLease',
        parameters: [pathParam('id', 'Lease ID.')],
        responses: {
          '200': ok('Lease revoked.', 'Lease'),
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '500': ERR_500,
        },
      },
    },

    // ---- Internal ----
    '/internal/watchdog': {
      post: {
        tags: ['Internal'],
        summary: 'Run the connection refresh watchdog',
        description:
          'Admin only. Scans all connections and refreshes any whose `refreshAfter` is in the past. Returns counts of refreshed / reauth-required / errored connections.',
        operationId: 'runWatchdog',
        responses: {
          '200': ok('Watchdog result.', 'HealthResponse'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/internal/seed': {
      post: {
        tags: ['Internal'],
        summary: 'Seed the demo dataset',
        description:
          'Admin only. Idempotently creates the demo workspace, service clients, secrets, connections, and grants. Returns the demo credentials map.',
        operationId: 'seedDemoData',
        responses: {
          '200': ok('Seed result with credentials.', 'HealthResponse'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/internal/demo-credentials': {
      get: {
        tags: ['Internal'],
        summary: 'List demo credentials',
        description:
          'Admin only. Returns the admin token + the demo service-client credential map. DEMO convenience — real client credentials are issued once and never re-readable.',
        operationId: 'listDemoCredentials',
        responses: {
          '200': ok('Demo credentials map.', 'ServiceClient'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },

    // ---- Dashboard ----
    '/dashboard/stats': {
      get: {
        tags: ['Dashboard'],
        summary: 'KPI stats for the operations dashboard',
        description:
          'Admin only. Returns top-line KPIs (totalSecrets, activeConnections, pendingRotations, reauthRequired, auditEvents24h, activeClients, totalClients, totalWorkspaces) plus the 6 soonest-expiring connections + secrets.',
        operationId: 'getDashboardStats',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID.')],
        responses: {
          '200': ok('Dashboard KPIs.', 'DashboardStats'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/dashboard/provider-health': {
      get: {
        tags: ['Dashboard'],
        summary: 'Aggregated provider health',
        description:
          'Admin only. Aggregates per (providerKey, adapterKey): connection counts, refresh success rate, average refresh latency.',
        operationId: 'getProviderHealth',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID.')],
        responses: {
          '200': ok('Provider health rows.', 'HealthResponse'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/dashboard/client-preview': {
      get: {
        tags: ['Dashboard'],
        summary: 'Least-privilege client preview',
        description:
          'Admin only. For each service client, lists the secrets it can access (with permissions) and the secrets it cannot. Powers the "Least-Privilege Preview" panel.',
        operationId: 'getClientPreview',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID.')],
        responses: {
          '200': ok('Per-client accessible / inaccessible secret lists.', 'ServiceClient'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/dashboard/compliance': {
      get: {
        tags: ['Dashboard'],
        summary: 'Policy & rotation compliance',
        description:
          'Admin only. Aggregates per-secret rotation-policy violations (stale_rotation, never_rotated, expired_secret, expiring_soon). Returns a compliance score and the violation list.',
        operationId: 'getCompliance',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID.')],
        responses: {
          '200': ok('Compliance summary + violation list.', 'Secret'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/dashboard/expiring-leases': {
      get: {
        tags: ['Dashboard'],
        summary: 'Expiring leases widget',
        description:
          'Admin only. Returns active (and stale-active) SecretLease rows expiring within the next hour.',
        operationId: 'getExpiringLeases',
        parameters: [queryParam('workspaceId', 'Filter by workspace ID.')],
        responses: {
          '200': ok('Expiring lease rows.', 'Lease'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/dashboard/audit-activity': {
      get: {
        tags: ['Dashboard'],
        summary: 'Time-bucketed audit activity',
        description:
          'Admin only. Returns audit-event counts bucketed into fixed-width time windows. Supports `?range=1h|24h|7d|30d`.',
        operationId: 'getAuditActivity',
        parameters: [
          queryParam('workspaceId', 'Filter by workspace ID.'),
          queryParam('range', 'Time range.', { enum: ['1h', '24h', '7d', '30d'] }),
        ],
        responses: {
          '200': ok('Buckets + totals (events/reveals/rotations/denied).', 'AuditEvent'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/dashboard/anomalies': {
      get: {
        tags: ['Dashboard'],
        summary: 'Anomalous access detection',
        description:
          'Admin only. Detects denied spikes, new source IPs, off-hours access, access bursts, and cross-workspace attempts in a time range.',
        operationId: 'getAnomalies',
        parameters: [
          queryParam('workspaceId', 'Filter by workspace ID.'),
          queryParam('range', 'Time range.', { enum: ['1h', '24h', '7d', '30d'] }),
        ],
        responses: {
          '200': ok('Anomaly rows with severity + metadata.', 'AuditEvent'),
          '401': ERR_401,
          '403': ERR_403,
          '500': ERR_500,
        },
      },
    },
    '/dashboard/remediate': {
      post: {
        tags: ['Dashboard'],
        summary: 'One-click compliance remediation',
        description:
          'Admin only. Generates a new version of a violating secret and records a `secret.remediate` audit event with `reasonCode = violation`.',
        operationId: 'remediateSecret',
        requestBody: requestBody('secretId + violation type.', 'Secret'),
        responses: {
          '200': ok('Remediation result with new version.', 'SecretVersion'),
          '400': ERR_400,
          '401': ERR_401,
          '403': ERR_403,
          '404': ERR_404,
          '422': ERR_422,
          '500': ERR_500,
        },
      },
    },
  },
}

// ---- Route handler -------------------------------------------------------

export const GET = handle(async (req) => {
  await adminOrThrow(req)

  // Audit `openapi.read` — fire-and-forget. Audit failures are swallowed
  // inside `recordEvent` so they never break the spec read.
  const requestId = getRequestId(req)
  const sourceIp = getSourceIp(req)
  emitAuditEvent({
    action: 'openapi.read',
    outcome: 'success',
    requestId,
    sourceIp,
  })

  // `json` already sets `content-type: application/json` + default 200 status.
  return json(spec)
})
