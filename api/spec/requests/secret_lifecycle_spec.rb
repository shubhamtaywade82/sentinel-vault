require "rails_helper"

RSpec.describe "Secret lifecycle", type: :request do
  let(:secret) { create(:vault_secret, value: "v1") }

  def active_versions = secret.versions.active

  it "should retire the previous version when a new one is written" do
    post "/api/v1/secrets/#{secret.id}/versions", params: { value: "v2" }, headers: admin_headers, as: :json

    expect(json.dig("version", "versionNumber")).to eq(2)
    expect(active_versions.pluck(:version_number)).to eq([ 2 ])
    expect(secret.reload.current_version.decrypt_value).to eq("v2")
  end

  it "should never allow two active versions, even bypassing the model" do
    duplicate = secret.current_version.attributes.except("id").merge("version_number" => 99)

    expect { SecretVersion.insert!(duplicate) }.to raise_error(ActiveRecord::RecordNotUnique)
  end

  it "should require an explicit value to rotate instead of inventing one" do
    post "/api/v1/secrets/#{secret.id}/rotate", headers: admin_headers, as: :json

    expect(error_code).to eq("validation_failed")
    expect(secret.versions.count).to eq(1)
  end

  it "should rotate with a supplied value and audit it" do
    post "/api/v1/secrets/#{secret.id}/rotate", params: { value: "v2", expiresInHours: 2 }, headers: admin_headers, as: :json

    expect(response).to have_http_status(:created)
    expect(secret.reload.expires_at).to be_within(1.minute).of(2.hours.from_now)
    expect(SecretAccessEvent.where(action: "secret.rotate")).to exist
  end

  it "should require the rotate grant for clients" do
    client, credential = client_with_credential(workspace: secret.workspace)
    grant!(client, secret, "value:read")

    post "/api/v1/secrets/#{secret.id}/rotate", params: { value: "v2" }, headers: bearer(credential), as: :json

    expect(error_code).to eq("grant_required")
  end

  it "should revoke by retiring the active version and blocking further writes" do
    post "/api/v1/secrets/#{secret.id}/revoke", headers: admin_headers, as: :json

    expect(json.dig("secret", "status")).to eq("revoked")
    expect(active_versions).to be_empty

    post "/api/v1/secrets/#{secret.id}/versions", params: { value: "v2" }, headers: admin_headers, as: :json
    expect(response).to have_http_status(:conflict)
  end

  it "should refuse upstream revocation loudly rather than skip it" do
    post "/api/v1/secrets/#{secret.id}/revoke", params: { revokeUpstream: true }, headers: admin_headers, as: :json

    expect(error_code).to eq("validation_failed")
    expect(secret.reload).to be_active
  end

  it "should diff two versions line by line" do
    first = secret.current_version
    post "/api/v1/secrets/#{secret.id}/versions", params: { value: "v1\nadded" }, headers: admin_headers, as: :json

    post "/api/v1/secrets/#{secret.id}/diff?admin_reveal_ok=true",
         params: { versionAId: first.id, versionBId: json.dig("version", "id") }, headers: admin_headers, as: :json

    expect(json["stats"]).to eq("additions" => 1, "removals" => 0, "context" => 1)
    expect(SecretAccessEvent.where(action: "secret.diff", outcome: "success")).to exist
  end

  it "should require audit:read for a client to read a secret's events" do
    client, credential = client_with_credential(workspace: secret.workspace)
    grant!(client, secret, "metadata:read")

    get "/api/v1/secrets/#{secret.id}/events", headers: bearer(credential)
    expect(error_code).to eq("grant_required")
  end
end
