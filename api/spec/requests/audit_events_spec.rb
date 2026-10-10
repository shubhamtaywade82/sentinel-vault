require "rails_helper"

RSpec.describe "Audit events", type: :request do
  let(:secret) { create(:vault_secret) }

  before do
    Current.principal = Principal.admin
    SecretAccessEvent.record!("secret.reveal", secret: secret)
    SecretAccessEvent.record_denial("secret.reveal", secret: secret)
    SecretAccessEvent.record!("grant.create", secret: create(:vault_secret))
  end

  def events(**query)
    get "/api/v1/audit_events", params: query, headers: admin_headers
    json["events"]
  end

  it "should filter by action prefix, outcome and workspace" do
    expect(events(action: "secret.rev").pluck("action").uniq).to eq([ "secret.reveal" ])
    expect(events(action: "secret.").pluck("action").uniq).to contain_exactly("secret.create", "secret.reveal")
    expect(events(outcome: "denied").size).to eq(1)
    expect(events(workspaceId: secret.workspace_id).pluck("secretPath").uniq).to eq([ secret.path ])
  end

  it "should treat LIKE wildcards in the action filter literally" do
    expect(events(action: "%")).to be_empty
  end

  it "should page with limit and offset, newest first" do
    first_page = events(limit: 2)
    second_page = events(limit: 2, offset: 2)

    expect(first_page.size).to eq(2)
    expect((first_page + second_page).pluck("id").uniq.size).to eq(first_page.size + second_page.size)
  end

  it "should be admin-only" do
    _, credential = client_with_credential

    get "/api/v1/audit_events", headers: bearer(credential)

    expect(error_code).to eq("admin_required")
  end
end
