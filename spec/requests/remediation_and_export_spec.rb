require "rails_helper"

RSpec.describe "Remediation and export", type: :request do
  let(:secret) { create(:vault_secret, value: "old") }

  def remediate(**params)
    post "/api/v1/dashboard/remediate", params: { secretId: secret.id, violation: "stale_rotation", **params }, headers: admin_headers, as: :json
  end

  it "should rotate to the supplied value and audit the remediation" do
    remediate(value: "new-real-value")

    expect(json["remediated"]).to eq("stale_rotation")
    expect(secret.reload.current_version.decrypt_value).to eq("new-real-value")
    expect(SecretAccessEvent.where(action: "secret.remediate")).to exist
  end

  it "should refuse to invent a value for a secret no provider refreshes" do
    remediate

    expect(error_code).to eq("validation_failed")
    expect(secret.versions.count).to eq(1)
  end

  it "should refresh through the provider for a connection-bound access token" do
    connection = create(:integration_connection, workspace: secret.workspace)
    connection.bindings.create!(vault_secret: secret, purpose: "access_token")
    allow(Providers::DhanV1).to receive(:refresh)
      .and_return(Providers::Result.success("access_token" => { value: "from-provider", expires_at: 1.day.from_now }))

    remediate(violation: "expiring_soon")

    expect(secret.reload.current_version.decrypt_value).to eq("from-provider")
  end

  it "should clear a stale expiry when an expired secret gets a new value without one" do
    secret.update!(expires_at: 1.day.ago)

    remediate(violation: "expired_secret", value: "fresh")

    expect(secret.reload.expires_at).to be_nil
  end

  describe "GET /audit_events/export" do
    it "should export CSV with spreadsheet formulas neutralised" do
      post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", params: { reason: "=HYPERLINK(\"https://evil\")" },
                                                                        headers: admin_headers, as: :json

      get "/api/v1/audit_events/export", headers: admin_headers

      rows = CSV.parse(response.body, headers: true)
      expect(response.media_type).to eq("text/csv")
      expect(response.headers["Cache-Control"]).to include("no-store")
      expect(rows.find { |row| row["action"] == "secret.reveal" }["reasonCode"]).to start_with("'=")
      expect(response.body).not_to include("old")
    end

    it "should be admin-only" do
      _, credential = client_with_credential

      get "/api/v1/audit_events/export", headers: bearer(credential)

      expect(error_code).to eq("admin_required")
    end
  end

  it "should audit a client's probe of another workspace's secret while answering not found" do
    _, credential = client_with_credential

    get "/api/v1/secrets/#{secret.id}", headers: bearer(credential)

    expect(error_code).to eq("secret_not_found")
    expect(SecretAccessEvent.find_by(action: "secret.lookup")).to have_attributes(outcome: "denied", reason_code: "cross_workspace",
                                                                                   workspace_id: secret.workspace_id)
  end
end
