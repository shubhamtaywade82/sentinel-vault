require "rails_helper"

RSpec.describe "Workspaces", type: :request do
  it "should list workspaces ordered by slug" do
    create(:workspace, slug: "zeta")
    create(:workspace, slug: "alpha")

    get "/api/v1/workspaces", headers: admin_headers

    expect(json["workspaces"].pluck("slug")).to eq(%w[alpha zeta])
    expect(json["workspaces"].first.keys).to contain_exactly("id", "slug", "name", "status", "createdAt", "updatedAt")
  end

  it "should create a workspace and audit it" do
    post "/api/v1/workspaces", params: { slug: "staging", name: "Staging" }, headers: admin_headers, as: :json

    expect(response).to have_http_status(:created)
    expect(SecretAccessEvent.where(action: "workspace.create", workspace_id: json.dig("workspace", "id"))).to exist
  end

  it "should reject an invalid slug" do
    post "/api/v1/workspaces", params: { slug: "Not Valid", name: "x" }, headers: admin_headers, as: :json

    expect(error_code).to eq("validation_failed")
  end

  it "should require both slug and name" do
    post "/api/v1/workspaces", params: { slug: "only-slug" }, headers: admin_headers, as: :json

    expect(response).to have_http_status(:unprocessable_content)
  end
end
