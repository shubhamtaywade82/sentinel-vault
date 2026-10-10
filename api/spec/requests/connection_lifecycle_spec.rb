require "rails_helper"

RSpec.describe "Connection lifecycle", type: :request do
  let(:workspace) { create(:workspace) }
  let(:connection) { create(:integration_connection, workspace: workspace, adapter_key: "dhan_v1") }

  before { bind_secrets(connection, "client_id" => "1100", "access_token" => "old-token") }

  def renewed = Providers::Result.success("access_token" => { value: "new-token", expires_at: 24.hours.from_now })

  describe "POST /connections/:id/refresh" do
    it "should run the refresh and return the run" do
      allow(Providers::DhanV1).to receive(:refresh).and_return(renewed)

      post "/api/v1/connections/#{connection.id}/refresh", headers: admin_headers, as: :json

      expect(response).to have_http_status(:accepted)
      expect(json.dig("rotationRun", "status")).to eq("succeeded")
    end

    it "should require connection:refresh for clients" do
      client, credential = client_with_credential(workspace: workspace)
      grant!(client, connection.bindings.first.vault_secret, "value:read")

      post "/api/v1/connections/#{connection.id}/refresh", headers: bearer(credential), as: :json

      expect(error_code).to eq("grant_required")
    end

    it "should answer 409 while another refresh holds the lease" do
      connection.update!(refresh_lease_expires_at: 30.seconds.from_now)

      post "/api/v1/connections/#{connection.id}/refresh", headers: admin_headers, as: :json

      expect(error_code).to eq("rotation_in_progress")
    end
  end

  describe "POST /connections/:id/credential with an expired token" do
    let(:reader) { client_with_credential(workspace: workspace) }

    before do
      connection.update!(access_expires_at: 1.minute.ago)
      grant!(reader.first, connection.bindings.find_by(purpose: "access_token").vault_secret, "value:read")
    end

    def fetch = post("/api/v1/connections/#{connection.id}/credential", headers: bearer(reader.last), as: :json)

    it "should refresh first and deliver the new token" do
      allow(Providers::DhanV1).to receive(:refresh).and_return(renewed)

      fetch

      expect(json["credential"]).to include("value" => "new-token", "refreshed" => true)
    end

    it "should refuse rather than return the expired token when refresh fails" do
      allow(Providers::DhanV1).to receive(:refresh).and_return(Providers::Result.failure("invalid_grant"))

      fetch

      expect(error_code).to eq("credential_refresh_unavailable")
      expect(response.body).not_to include("old-token")
    end
  end

  describe "POST /connections/:id/reauthorize" do
    it "should regenerate unattended when PIN and TOTP are stored" do
      bind_secrets(connection, "pin" => "1234", "totp_seed" => ROTP::Base32.random)
      allow(Providers::DhanV1).to receive(:reauthorize).and_return(renewed)

      post "/api/v1/connections/#{connection.id}/reauthorize", headers: admin_headers, as: :json

      expect(json.dig("rotationRun", "operation")).to eq("reauthorize")
      expect(json.dig("rotationRun", "status")).to eq("succeeded")
    end

    it "should record that a person must re-authorize otherwise, not pretend success" do
      post "/api/v1/connections/#{connection.id}/reauthorize", headers: admin_headers, as: :json

      expect(json.dig("rotationRun", "errorCode")).to eq("manual_reauth_required")
      expect(connection.reload).to be_reauth_required
    end
  end

  describe "POST /connections/:id/recover" do
    before { connection.update!(status: "reauth_required", last_error_code: "invalid_grant") }

    it "should store the new access token and re-arm the connection" do
      post "/api/v1/connections/#{connection.id}/recover",
           params: { newAccessToken: "hand-made", accessExpiresAt: 6.hours.from_now.iso8601 }, headers: admin_headers, as: :json

      expect(json.dig("connection", "status")).to eq("active")
      expect(connection.reload.bindings.find_by(purpose: "access_token").vault_secret.current_version.decrypt_value).to eq("hand-made")
      expect(RotationRun.find_by(operation: "recover")).to be_succeeded
    end

    it "should reject token material with no binding to hold it" do
      post "/api/v1/connections/#{connection.id}/recover", params: { newRefreshToken: "rt" }, headers: admin_headers, as: :json

      expect(error_code).to eq("validation_failed")
      expect(connection.reload).to be_reauth_required
    end
  end

  describe "rotation runs and watchdog" do
    it "should list and show runs filtered by connection" do
      run = connection.rotation_runs.create!(operation: "refresh", status: "failed", error_code: "invalid_grant")

      get "/api/v1/rotation_runs", params: { connectionId: connection.id }, headers: admin_headers
      expect(json["runs"].pluck("id")).to eq([ run.id ])

      get "/api/v1/rotation_runs/#{run.id}", headers: admin_headers
      expect(json.dig("run", "connectionId")).to eq(connection.id)
    end

    it "should sweep due connections and summarise the outcomes" do
      connection.update!(refresh_after: 1.minute.ago)
      static = create(:integration_connection, workspace: workspace, adapter_key: "api_key_static", refresh_after: 1.minute.ago)
      allow(Providers::DhanV1).to receive(:refresh).and_return(renewed)

      post "/api/v1/internal/watchdog", headers: admin_headers, as: :json

      expect(json["checked"]).to eq(2)
      expect(json["refreshed"]).to eq([ { "connectionId" => connection.id, "status" => "succeeded" } ])
      expect(json["reauthRequired"]).to eq([ { "connectionId" => static.id, "errorCode" => "manual_rotation_required" } ])
    end
  end
end
