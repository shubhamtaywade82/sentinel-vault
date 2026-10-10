require "rails_helper"

RSpec.describe "Error handling", type: :request do
  around do |example|
    # Production behaviour: Rails renders exceptions through the exceptions app.
    env_config = Rails.application.env_config
    overrides = { "action_dispatch.show_exceptions" => :all, "action_dispatch.show_detailed_exceptions" => false }
    original = env_config.slice(*overrides.keys)
    env_config.merge!(overrides)
    example.run
  ensure
    env_config.merge!(original)
  end

  it "should render an unexpected error in the contract envelope and report it" do
    allow(Workspace).to receive(:order).and_raise(RuntimeError, "boom")
    reports = []
    subscriber = Class.new { define_method(:report) { |error, **| reports << error } }.new
    Rails.error.subscribe(subscriber)

    get "/api/v1/workspaces", headers: admin_headers

    expect(response).to have_http_status(:internal_server_error)
    expect(json).to eq("error" => { "code" => "internal_error", "message" => "Internal Server Error" })
    expect(reports.map(&:message)).to include("boom")
  ensure
    Rails.error.unsubscribe(subscriber)
  end

  it "should answer malformed JSON with a 400 envelope" do
    post "/api/v1/workspaces", params: "{not json", headers: admin_headers.merge("Content-Type" => "application/json")

    expect(response).to have_http_status(:bad_request)
    expect(error_code).to eq("validation_failed")
  end

  it "should answer a duplicate with 409 whether validation or the index catches it" do
    workspace = create(:workspace)

    post "/api/v1/workspaces", params: { slug: workspace.slug, name: "Again" }, headers: admin_headers, as: :json

    expect(response).to have_http_status(:conflict)
  end

  it "should reject a non-string permissions payload with 422" do
    client = create(:service_client)
    secret = create(:vault_secret, workspace: client.workspace)

    post "/api/v1/admin/grants", params: { serviceClientId: client.id, vaultSecretId: secret.id, permissions: { all: true } },
                                 headers: admin_headers, as: :json

    expect(error_code).to eq("validation_failed")
  end
end
