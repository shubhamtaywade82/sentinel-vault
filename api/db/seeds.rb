# Demo data for local development. Secret values are random placeholders and
# client credentials are printed once, never written to disk.
abort "Refusing to seed demo data in production" if Rails.env.production?
if Workspace.exists?(slug: "production")
  puts "Already seeded; run bin/rails db:reset to start over"
  return
end

SECRETS = {
  "dhan/prod/access-token" => [ "access_token", "dhan" ],
  "dhan/prod/refresh-token" => [ "refresh_token", "dhan" ],
  "dhan/prod/totp-seed" => [ "totp_seed", "dhan" ],
  "broker/prod/api-key" => [ "api_key", "broker" ],
  "db/prod/connection-string" => [ "connection_string", nil ],
  "web/prod/stripe-secret" => [ "api_key", "stripe" ]
}.freeze

GRANTS = {
  "algo-scalper-bot" => { "dhan/prod/access-token" => %w[value:read] },
  "nexum-gateway" => { "dhan/prod/access-token" => %w[value:read connection:refresh], "broker/prod/api-key" => %w[value:read] },
  "web-backend" => { "db/prod/connection-string" => %w[value:read], "web/prod/stripe-secret" => %w[value:read] },
  "reporting-cli" => { "dhan/prod/access-token" => %w[metadata:read audit:read] }
}.freeze

Current.principal = Principal.admin
%w[development staging].each { |slug| Workspace.create!(slug: slug, name: slug.titleize) }
production = Workspace.create!(slug: "production", name: "Production")

secrets = SECRETS.to_h do |path, (kind, provider)|
  secret = production.vault_secrets.create!(path: path, name: path.split("/").last.titleize, kind: kind, provider: provider)
  Secrets::WriteVersion.call(secret, "secret.create", { value: "demo-#{SecureRandom.hex(16)}", created_by: "seed" })
  [ path, secret ]
end

dhan = production.integration_connections.create!(
  provider_key: "dhan", auth_method: "oauth2_refresh", adapter_key: "dhan_v1",
  access_expires_at: 90.minutes.from_now, refresh_after: 45.minutes.from_now
)
dhan.bindings.create!(vault_secret: secrets.fetch("dhan/prod/access-token"), purpose: "access_token")
dhan.bindings.create!(vault_secret: secrets.fetch("dhan/prod/refresh-token"), purpose: "refresh_token")

puts "Demo client credentials (shown once):"
GRANTS.each do |name, grants|
  client = production.service_clients.new(name: name, client_type: name.end_with?("cli") ? "cli" : "bot")
  puts "  #{name}: #{client.issue_credential!}"
  grants.each { |path, permissions| SecretAccessGrant.create!(service_client: client, vault_secret: secrets.fetch(path), permissions: permissions) }
end
