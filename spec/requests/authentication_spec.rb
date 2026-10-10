require "rails_helper"

RSpec.describe "Authentication", type: :request do
  it "should serve liveness without credentials" do
    get "/api/v1/health/live"

    expect(response).to have_http_status(:ok)
    expect(json["status"]).to eq("alive")
  end

  it "should report readiness including a crypto round trip" do
    get "/api/v1/health/ready"

    expect(json).to include("status" => "ready", "db" => "ok", "crypto" => "ok")
  end

  it "should return 401 with the error envelope when no token is sent" do
    get "/api/v1/me"

    expect(response).to have_http_status(:unauthorized)
    expect(error_code).to eq("unauthorized")
  end

  it "should return 401 for an unknown token" do
    get "/api/v1/me", headers: bearer("vlt_live_#{SecureRandom.hex(32)}")

    expect(response).to have_http_status(:unauthorized)
  end

  it "should identify the admin" do
    get "/api/v1/me", headers: admin_headers

    expect(json.dig("client", "permissions")).to eq([ "admin" ])
  end

  it "should identify a client and record its last use" do
    client, credential = client_with_credential

    get "/api/v1/me", headers: bearer(credential)

    expect(json.dig("client", "id")).to eq(client.id)
    expect(client.reload.last_used_at).to be_present
  end

  it "should reject revoked, expired and suspended-workspace clients" do
    _, revoked = client_with_credential(status: "revoked", revoked_at: Time.current)
    _, expired = client_with_credential(expires_at: 1.minute.ago)
    _, suspended = client_with_credential(workspace: create(:workspace, status: "suspended"))

    [ revoked, expired, suspended ].each do |credential|
      get "/api/v1/me", headers: bearer(credential)
      expect(response).to have_http_status(:unauthorized)
    end
  end

  it "should refuse admin endpoints to clients" do
    _, credential = client_with_credential

    get "/api/v1/workspaces", headers: bearer(credential)

    expect(response).to have_http_status(:forbidden)
    expect(error_code).to eq("admin_required")
  end
end
