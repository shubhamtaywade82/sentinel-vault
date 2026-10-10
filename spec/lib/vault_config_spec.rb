require "rails_helper"

RSpec.describe VaultConfig do
  around do |example|
    original = ENV.to_h.slice("VAULT_ADMIN_TOKEN", "VAULT_KMS_PROVIDER", "VAULT_MASTER_KEY", "VAULT_KMS_KEY_ID")
    example.run
  ensure
    original.each { |key, value| ENV[key] = value }
    ENV.delete("VAULT_KMS_KEY_ID") unless original.key?("VAULT_KMS_KEY_ID")
  end

  it "should accept the test configuration" do
    expect { described_class.validate! }.not_to raise_error
  end

  it "should refuse to start without an admin token" do
    ENV.delete("VAULT_ADMIN_TOKEN")

    expect { described_class.validate! }.to raise_error(VaultConfig::MissingConfiguration, /VAULT_ADMIN_TOKEN/)
  end

  it "should refuse a short admin token" do
    ENV["VAULT_ADMIN_TOKEN"] = "too-short"

    expect { described_class.validate! }.to raise_error(VaultConfig::MissingConfiguration, /at least 32/)
  end

  it "should refuse a master key that is not 32 bytes" do
    ENV["VAULT_MASTER_KEY"] = Base64.strict_encode64("16-bytes-only!!!")

    expect { described_class.validate! }.to raise_error(VaultConfig::MissingConfiguration, /32 bytes/)
  end

  it "should refuse the local key provider in production" do
    allow(Rails).to receive(:env).and_return(ActiveSupport::EnvironmentInquirer.new("production"))

    expect { described_class.validate! }.to raise_error(VaultConfig::MissingConfiguration, /refused in production/)
  end

  it "should require a KMS key id for the aws_kms provider" do
    ENV["VAULT_KMS_PROVIDER"] = "aws_kms"
    ENV.delete("VAULT_KMS_KEY_ID")

    expect { described_class.validate! }.to raise_error(VaultConfig::MissingConfiguration, /VAULT_KMS_KEY_ID/)
  end
end
