FactoryBot.define do
  factory :workspace do
    sequence(:slug) { |n| "workspace-#{n}" }
    name { slug.titleize }
  end

  factory :service_client do
    workspace
    sequence(:name) { |n| "client-#{n}" }
    client_type { "bot" }
    credential_digest { ServiceClient.digest(SecureRandom.hex(16)) }
    credential_prefix { "vlt_live_x" }
  end

  factory :vault_secret do
    workspace
    sequence(:path) { |n| "app/prod/secret-#{n}" }
    name { "Secret" }
    kind { "api_key" }

    transient { value { "initial-value" } }

    after(:create) do |secret, context|
      Secrets::WriteVersion.call(secret, "secret.create", { value: context.value, created_by: "admin" })
    end
  end

  factory :secret_access_grant do
    service_client
    vault_secret { association :vault_secret, workspace: service_client.workspace }
    permissions { [ "metadata:read" ] }
  end

  factory :integration_connection do
    workspace
    provider_key { "dhan" }
    auth_method { "oauth2_refresh" }
    adapter_key { "dhan_v1" }
    access_expires_at { 1.hour.from_now }
  end
end
