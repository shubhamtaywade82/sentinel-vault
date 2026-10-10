require "rails_helper"

RSpec.describe "Leases", type: :request do
  let(:secret) { create(:vault_secret) }
  let(:holder) { client_with_credential(workspace: secret.workspace) }

  before { grant!(holder.first, secret, "value:read", "metadata:read") }

  def issue(headers: admin_headers, **params)
    defaults = { serviceClientId: holder.first.id, permissions: [ "value:read" ], ttlSeconds: 300 }
    post "/api/v1/secrets/#{secret.id}/leases", params: defaults.merge(params), headers: headers, as: :json
  end

  it "should issue a lease within the client's grant and audit it" do
    issue

    expect(response).to have_http_status(:created)
    expect(json["lease"]).to include("grantedPermissions" => "value:read", "status" => "active", "serviceClientName" => holder.first.name)
    expect(SecretAccessEvent.find_by(action: "lease.issue").reason_code).to eq("ttl=300s;perms=value:read")
  end

  it "should refuse permissions beyond the client's grant" do
    issue(permissions: [ "rotate" ])

    expect(error_code).to eq("validation_failed")
  end

  it "should refuse out-of-range TTLs" do
    [ 59, 86_401, "soon" ].each do |ttl|
      issue(ttlSeconds: ttl)
      expect(error_code).to eq("validation_failed")
    end
  end

  it "should let a client lease only for itself" do
    other, = client_with_credential(workspace: secret.workspace)

    issue(serviceClientId: other.id, headers: bearer(holder.last))

    expect(error_code).to eq("grant_required")
  end

  it "should report a lapsed lease as expired without any background job" do
    issue
    travel 301.seconds do
      get "/api/v1/leases", params: { activeOnly: "true" }, headers: admin_headers
      expect(json["leases"]).to be_empty

      get "/api/v1/secrets/#{secret.id}/leases", headers: admin_headers
      expect(json["leases"].first["status"]).to eq("expired")
    end
  end

  it "should let a client see and revoke only its own leases" do
    issue
    lease_id = json.dig("lease", "id")
    _, outsider = client_with_credential(workspace: secret.workspace)

    delete "/api/v1/leases/#{lease_id}", headers: bearer(outsider)
    expect(error_code).to eq("resource_not_found")

    delete "/api/v1/leases/#{lease_id}", headers: bearer(holder.last)
    expect(json.dig("lease", "status")).to eq("revoked")
  end
end
