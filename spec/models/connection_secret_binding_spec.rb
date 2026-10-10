require "rails_helper"

RSpec.describe ConnectionSecretBinding do
  let(:connection) { create(:integration_connection) }

  it "should copy the connection's workspace" do
    binding = connection.bindings.create!(vault_secret: create(:vault_secret, workspace: connection.workspace), purpose: "access_token")

    expect(binding.workspace_id).to eq(connection.workspace_id)
  end

  it "should refuse a secret from another workspace at the database level" do
    foreign_secret = create(:vault_secret)
    binding = connection.bindings.new(vault_secret: foreign_secret, purpose: "access_token")

    expect { binding.save! }.to raise_error(ActiveRecord::InvalidForeignKey, /same_workspace/)
  end

  it "should allow one secret per purpose on a connection" do
    secret = create(:vault_secret, workspace: connection.workspace)
    connection.bindings.create!(vault_secret: secret, purpose: "access_token")

    expect(connection.bindings.new(vault_secret: secret, purpose: "access_token")).not_to be_valid
  end
end
