require "rails_helper"

RSpec.describe "Secret reads", type: :request do
  let(:secret) { create(:vault_secret, value: "first-#{SecureRandom.hex(8)}") }
  let(:second_value) { "second-#{SecureRandom.hex(8)}" }
  let(:client_and_credential) { client_with_credential(workspace: secret.workspace) }

  before { Secrets::WriteVersion.call(secret, "secret.rotate", { value: second_value, created_by: "admin" }) }

  it "should show a secret with its version history to any grant holder, never the value" do
    grant!(client_and_credential.first, secret, "metadata:read")

    get "/api/v1/secrets/#{secret.id}", headers: bearer(client_and_credential.last)

    expect(json.dig("secret", "versions").pluck("versionNumber")).to eq([ 2, 1 ])
    expect(response.body).not_to include("first-", second_value)
  end

  it "should list versions newest first" do
    get "/api/v1/secrets/#{secret.id}/versions", headers: admin_headers

    expect(json["versions"].pluck("versionNumber", "status")).to eq([ [ 2, "active" ], [ 1, "retired" ] ])
  end

  it "should list a secret's events for an audit:read holder, capped by limit" do
    grant!(client_and_credential.first, secret, "audit:read")

    get "/api/v1/secrets/#{secret.id}/events", params: { limit: 1 }, headers: bearer(client_and_credential.last)

    expect(json["events"].size).to eq(1)
    expect(json["events"].first["action"]).to eq("secret.rotate")
  end

  it "should deny a client with no grant at all" do
    client_and_credential

    get "/api/v1/secrets/#{secret.id}", headers: bearer(client_and_credential.last)

    expect(error_code).to eq("grant_required")
  end
end
