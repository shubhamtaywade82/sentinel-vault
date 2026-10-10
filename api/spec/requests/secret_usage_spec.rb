require "rails_helper"

RSpec.describe "Secret usage", type: :request do
  let(:secret) { create(:vault_secret) }

  it "should report every dependent client, connection and active lease" do
    client, = client_with_credential(workspace: secret.workspace)
    grant!(client, secret, "value:read")
    connection = create(:integration_connection, workspace: secret.workspace)
    connection.bindings.create!(vault_secret: secret, purpose: "access_token")
    SecretLease.create!(vault_secret: secret, service_client: client, granted_permissions: [ "value:read" ], expires_at: 1.hour.from_now)

    get "/api/v1/secrets/#{secret.id}/usage", headers: admin_headers

    expect(json["blastRadius"]).to eq("clientCount" => 1, "connectionCount" => 1, "activeLeaseCount" => 1)
    expect(json.dig("usage", "connections", 0, "purpose")).to eq("access_token")
    expect(SecretAccessEvent.where(action: "secret.usage")).to exist
  end

  it "should require a grant for clients" do
    _, credential = client_with_credential(workspace: secret.workspace)

    get "/api/v1/secrets/#{secret.id}/usage", headers: bearer(credential)

    expect(error_code).to eq("grant_required")
  end
end
