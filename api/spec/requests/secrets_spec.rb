require "rails_helper"

RSpec.describe "Secrets", type: :request do
  let(:workspace) { create(:workspace) }
  let(:secret) { create(:vault_secret, workspace: workspace, value: "token-123") }

  describe "POST /api/v1/secrets" do
    let(:params) { { workspaceId: workspace.id, path: "db/prod/url", name: "DB", kind: "connection_string", value: "postgres://x" } }

    it "should create an encrypted first version and audit it" do
      post "/api/v1/secrets", params: params, headers: admin_headers, as: :json

      expect(response).to have_http_status(:created)
      version = SecretVersion.find(json.dig("version", "id"))
      expect(version.ciphertext).not_to include("postgres")
      expect(version.decrypt_value).to eq("postgres://x")
      expect(SecretAccessEvent.where(action: "secret.create", secret_version_id: version.id)).to exist
    end

    it "should reject an unknown kind with validation_failed" do
      post "/api/v1/secrets", params: params.merge(kind: "password"), headers: admin_headers, as: :json

      expect(response).to have_http_status(:unprocessable_content)
      expect(error_code).to eq("validation_failed")
    end

    it "should never echo the value in the response" do
      post "/api/v1/secrets", params: params, headers: admin_headers, as: :json

      expect(response.body).not_to include("postgres://x")
    end
  end

  describe "tenant isolation" do
    it "should list only the client's granted secrets in its own workspace" do
      client, credential = client_with_credential(workspace: workspace)
      grant!(client, secret, "metadata:read")
      create(:vault_secret, workspace: workspace)
      create(:vault_secret)

      get "/api/v1/secrets", headers: bearer(credential)

      expect(json["secrets"].pluck("id")).to eq([ secret.id ])
    end

    it "should answer not found for another workspace's secret" do
      _, credential = client_with_credential
      get "/api/v1/secrets/#{secret.id}", headers: bearer(credential)

      expect(response).to have_http_status(:not_found)
      expect(error_code).to eq("secret_not_found")
    end

    it "should answer not found for malformed ids" do
      get "/api/v1/secrets/not-a-uuid", headers: admin_headers

      expect(error_code).to eq("secret_not_found")
    end
  end

  describe "POST /api/v1/secrets/:id/reveal" do
    it "should require the admin confirmation flag and audit the denial" do
      post "/api/v1/secrets/#{secret.id}/reveal", headers: admin_headers, as: :json

      expect(response).to have_http_status(:forbidden)
      expect(SecretAccessEvent.where(action: "secret.reveal", outcome: "denied")).to exist
    end

    it "should reveal to a confirmed admin without caching and audit it" do
      post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", params: { reason: "incident 42" }, headers: admin_headers, as: :json

      expect(json["value"]).to eq("token-123")
      expect(response.headers["Cache-Control"].split(", ")).to contain_exactly("no-store", "private")
      expect(SecretAccessEvent.find_by(action: "secret.reveal", outcome: "success").reason_code).to eq("incident 42")
    end

    it "should require value:read for clients even with metadata:read" do
      client, credential = client_with_credential(workspace: workspace)
      grant!(client, secret, "metadata:read")

      post "/api/v1/secrets/#{secret.id}/reveal", headers: bearer(credential), as: :json

      expect(error_code).to eq("grant_required")
      expect(response.body).not_to include("token-123")
    end

    it "should reveal to a client holding value:read and attribute the audit row" do
      client, credential = client_with_credential(workspace: workspace)
      grant!(client, secret, "value:read")

      post "/api/v1/secrets/#{secret.id}/reveal", headers: bearer(credential), as: :json

      expect(json["value"]).to eq("token-123")
      expect(SecretAccessEvent.find_by(action: "secret.reveal", outcome: "success").actor_client_id).to eq(client.id)
    end

    it "should not fingerprint the plaintext in an ETag header" do
      post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", headers: admin_headers, as: :json

      expect(response.headers).not_to have_key("ETag")
    end

    it "should answer 503 when the key service is unreachable" do
      secret
      allow(Encryption.kms).to receive(:decrypt_data_key).and_raise(Seahorse::Client::NetworkingError.new(Net::ReadTimeout.new))

      post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", headers: admin_headers, as: :json

      expect(response).to have_http_status(:service_unavailable)
      expect(error_code).to eq("provider_unavailable")
    end

    it "should report a failed audit write to the error tracker" do
      secret
      allow(SecretAccessEvent).to receive(:create!).and_raise(ActiveRecord::ConnectionFailed)
      allow(Rails.error).to receive(:report)

      post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", headers: admin_headers, as: :json

      expect(Rails.error).to have_received(:report).with(ActiveRecord::ConnectionFailed, hash_including(handled: true))
    end

    it "should withhold plaintext when the audit row cannot be written" do
      allow(SecretAccessEvent).to receive(:create!).and_call_original
      allow(SecretAccessEvent).to receive(:create!).with(hash_including(action: "secret.reveal")).and_raise(ActiveRecord::ConnectionFailed)

      post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", headers: admin_headers, as: :json

      expect(error_code).to eq("audit_persist_failed")
      expect(response.body).not_to include("token-123")
    end

    it "should refuse to reveal a revoked secret" do
      secret.update!(status: "revoked", revoked_at: Time.current)

      post "/api/v1/secrets/#{secret.id}/reveal?admin_reveal_ok=true", headers: admin_headers, as: :json

      expect(response).to have_http_status(:conflict)
    end
  end
end
