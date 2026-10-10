# Connecting a service to Sentinel Vault

How a trading bot, app or worker fetches its secrets. Every example here was run against a
local stack started with `bin/dev`.

## How access works

- A service authenticates with its own **service-client credential** (`vlt_live_…`), sent as
  `Authorization: Bearer <credential>`. Never give a service the admin token.
- It sees only secrets in **its own workspace** that it holds a **grant** for. Reading a value
  needs the `value:read` permission.
- Every reveal and credential delivery is written to the audit log under the service's name.
- Plaintext responses carry `Cache-Control: no-store, private`.

Locally the API is `http://localhost:4781` (the UI's `:4750` proxies to it, but services do not
need the UI). In production use `https://`.

## 1. Onboard the service (admin, once)

In the UI: **Service Clients → New Client**, copy the credential (it is shown once), then grant
access under **Access Grants**. Or with curl:

```bash
ADMIN=$(sed -n 's/^VAULT_ADMIN_TOKEN=//p' .env)
V=http://localhost:4781/api/v1

# Workspace ids
curl -s -H "Authorization: Bearer $ADMIN" $V/workspaces

# Create the client; store "credential" from the response now, it is never shown again
curl -s -X POST $V/admin/service_clients -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"my-bot","clientType":"bot","workspaceId":"<workspace id>","expiresInDays":30}'

# Grant only what the service needs (repeat per secret)
curl -s -X POST $V/admin/grants -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"serviceClientId":"<client id>","vaultSecretId":"<secret id>","permissions":"value:read"}'
```

Hand the credential to the service through its environment:

```bash
export VAULT_URL=http://localhost:4781
export VAULT_CLIENT_TOKEN=vlt_live_...      # never commit this
export VAULT_CONNECTION_ID=<connection id>  # for provider tokens, see below
```

## 2. What the service calls

| Need | Call | Response |
|---|---|---|
| Check identity and grants | `GET /api/v1/me` | `{ client, grants: [{ secretPath, permissions }] }` |
| Static secret (API key, DB URL) | `POST /api/v1/secrets/:id/reveal` | `{ value, version }` |
| Expiring provider token (e.g. Dhan) | `POST /api/v1/connections/:id/credential` with `{"purpose":"access_token"}` | `{ credential: { value, expiresAt, refreshed } }` |

Use the **connection** endpoint for tokens that expire. The vault renews an expired token with
the provider before answering, and refuses rather than return a stale one. Only access tokens
leave through a connection; refresh tokens, PINs and TOTP seeds never do.

Quick check:

```bash
curl -s -H "Authorization: Bearer $VAULT_CLIENT_TOKEN" $VAULT_URL/api/v1/me
curl -s -X POST -H "Authorization: Bearer $VAULT_CLIENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"purpose":"access_token"}' $VAULT_URL/api/v1/connections/$VAULT_CONNECTION_ID/credential
```

## 3. Ruby client

Standard library only. Copy into the service as `vault_client.rb`:

```ruby
require "net/http"
require "json"
require "time"

# Minimal Sentinel Vault client for a service such as a trading bot.
# Configure with VAULT_URL and VAULT_CLIENT_TOKEN (the bot's vlt_live_ credential).
module Vault
  # The vault refused the request; `code` is the API's error code, e.g. "grant_required".
  class RequestError < StandardError
    attr_reader :code, :status

    def initialize(code, status)
      super("vault refused: #{code} (HTTP #{status})")
      @code = code
      @status = status
    end
  end

  OPEN_TIMEOUT = 3
  READ_TIMEOUT = 10

  module_function

  # Plaintext of a static secret (API key, connection string). Needs value:read.
  def reveal(secret_id, reason: nil)
    post("/api/v1/secrets/#{secret_id}/reveal", { reason: reason }.compact).fetch("value")
  end

  def post(path, payload)
    uri = URI("#{ENV.fetch('VAULT_URL')}#{path}")
    request = Net::HTTP::Post.new(uri, "Authorization" => "Bearer #{ENV.fetch('VAULT_CLIENT_TOKEN')}",
                                       "Content-Type" => "application/json")
    request.body = payload.to_json
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                                                    open_timeout: OPEN_TIMEOUT, read_timeout: READ_TIMEOUT) do |http|
      http.request(request)
    end
    body = JSON.parse(response.body)
    return body if response.is_a?(Net::HTTPSuccess)

    raise RequestError.new(body.dig("error", "code") || "http_#{response.code}", response.code.to_i)
  end

  # A provider access token served through a connection, re-fetched shortly before
  # it expires. The vault renews expired tokens with the provider before answering.
  class AccessToken
    REFETCH_BEFORE_EXPIRY = 60 # seconds
    DEFAULT_CACHE = 300 # seconds, when the vault reports no expiry

    def initialize(connection_id)
      @path = "/api/v1/connections/#{connection_id}/credential"
    end

    def value
      fetch if @expires_at.nil? || Time.now >= @expires_at - REFETCH_BEFORE_EXPIRY
      @value
    end

    private

    def fetch
      credential = Vault.post(@path, { purpose: "access_token" }).fetch("credential")
      @value = credential.fetch("value")
      @expires_at = credential["expiresAt"] ? Time.parse(credential["expiresAt"]) : Time.now + DEFAULT_CACHE
    end
  end
end
```

Usage:

```ruby
require_relative "vault_client"

DHAN_TOKEN = Vault::AccessToken.new(ENV.fetch("VAULT_CONNECTION_ID"))
STRIPE_KEY = Vault.reveal("<secret id>", reason: "service startup")

# Call DHAN_TOKEN.value on every use: it is cached and re-fetched shortly before expiry.
```

## 4. TypeScript client

No dependencies; Node 18+ or Bun (uses the built-in `fetch`). Copy into the service as
`vault-client.ts`:

```ts
// Minimal Sentinel Vault client for a service such as a trading bot (Node 18+ or Bun).
// Configure with VAULT_URL and VAULT_CLIENT_TOKEN (the bot's vlt_live_ credential).

const TIMEOUT_MS = 10_000;

/** The vault refused the request; `code` is the API's error code, e.g. "grant_required". */
export class VaultRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`vault refused: ${code} (HTTP ${status})`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function post<T>(path: string, payload: object): Promise<T> {
  const response = await fetch(`${requireEnv("VAULT_URL")}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("VAULT_CLIENT_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json();
  if (!response.ok) throw new VaultRequestError(body?.error?.code ?? `http_${response.status}`, response.status);
  return body as T;
}

/** Plaintext of a static secret (API key, connection string). Needs value:read. */
export async function revealSecret(secretId: string, reason?: string): Promise<string> {
  const body = await post<{ value: string }>(`/api/v1/secrets/${secretId}/reveal`, { reason });
  return body.value;
}

interface CredentialResponse {
  credential: { value: string; expiresAt: string | null; refreshed: boolean; versionId: string };
}

/**
 * A provider access token served through a connection, re-fetched shortly before it
 * expires. The vault renews expired tokens with the provider before answering.
 */
export class VaultAccessToken {
  private static readonly REFETCH_BEFORE_EXPIRY_MS = 60_000;
  private static readonly DEFAULT_CACHE_MS = 300_000; // when the vault reports no expiry

  private value: string | null = null;
  private expiresAt = 0;
  // Concurrent callers share one fetch instead of each hitting the vault.
  private inflight: Promise<void> | null = null;

  constructor(private readonly connectionId: string) {}

  async get(): Promise<string> {
    if (this.value === null || Date.now() >= this.expiresAt - VaultAccessToken.REFETCH_BEFORE_EXPIRY_MS) {
      this.inflight ??= this.fetch().finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }
    return this.value as string;
  }

  private async fetch(): Promise<void> {
    const { credential } = await post<CredentialResponse>(`/api/v1/connections/${this.connectionId}/credential`, {
      purpose: "access_token",
    });
    this.value = credential.value;
    this.expiresAt = credential.expiresAt
      ? Date.parse(credential.expiresAt)
      : Date.now() + VaultAccessToken.DEFAULT_CACHE_MS;
  }
}
```

Usage:

```ts
import { VaultAccessToken, VaultRequestError, revealSecret } from "./vault-client";

const dhanToken = new VaultAccessToken(process.env.VAULT_CONNECTION_ID!);
const stripeKey = await revealSecret("<secret id>", "service startup");

// Await dhanToken.get() on every use: cached, re-fetched before expiry, and concurrent
// callers share a single request.
const accessToken = await dhanToken.get();
```

## 5. Handling errors

Both clients raise an error carrying the API's error code (`Vault::RequestError#code`,
`VaultRequestError.code`).

| Status | Code | Meaning | Service should |
|---|---|---|---|
| 401 | `unauthorized` | Credential wrong, expired or revoked | Stop and alert; an admin must issue a new credential |
| 403 | `grant_required` | No grant for this secret | Alert; an admin must grant it |
| 403 | `secret_access_denied` | Asked a connection for something other than an access token | Fix the request |
| 404 | `secret_not_found`, `connection_not_found` | Unknown id, or not in this service's workspace | Fix the id |
| 409 | `conflict` | Secret is revoked | Alert |
| 422 | `credential_refresh_unavailable` | Token expired and renewal failed, or one is in progress | Retry with backoff |
| 422 | `reauthorization_required` | Connection needs a person to re-authorize | Stop trading and alert |
| 429 | `rate_limited` | Over 60 credential fetches or 30 reveals per minute | Cache (the clients do) and back off |
| 503 | `provider_unavailable` | Key management unreachable | Retry with backoff |

## 6. Operating rules

- **Keep the credential out of code and logs.** Environment variable or secret file only.
- **Fetch at use, not once at boot**, for expiring tokens. The clients cache for you.
- **Rotate** a service's credential from Service Clients; the old one stops working at once.
- **Revoke** a client to cut it off for good; revocation cannot be undone.
- **Grant least privilege**: `value:read` on exactly the secrets the service uses.
