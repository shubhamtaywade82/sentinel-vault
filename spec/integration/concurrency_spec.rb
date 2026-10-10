require "rails_helper"

# Real row locks need real transactions on separate connections, so these
# examples commit and clean up by TRUNCATE (the audit trigger is row-level).
RSpec.describe "Concurrent secret access" do
  self.use_transactional_tests = false

  TABLES = %w[secret_access_events secret_access_grants connection_secret_bindings secret_versions vault_secrets
              service_clients integration_connections workspaces].freeze

  after { ActiveRecord::Base.connection.execute("TRUNCATE #{TABLES.join(', ')} CASCADE") }

  before { Current.principal = Principal.admin }

  let!(:secret) { create(:vault_secret, value: "v1") }

  def in_thread(&block)
    Thread.new do
      Current.principal = Principal.admin
      ActiveRecord::Base.connection_pool.with_connection(&block)
    end
  end

  it "should make a revoke wait until an in-flight read releases its share lock" do
    locked = Queue.new
    reader = in_thread do
      VaultSecret.transaction do
        VaultSecret.find(secret.id).lock!("FOR SHARE")
        locked << true
        sleep 0.5
      end
    end
    locked.pop

    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    in_thread { VaultSecret.find(secret.id).revoke! }.join
    waited = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
    reader.join

    expect(waited).to be >= 0.3
    expect(secret.reload).to be_revoked
  end

  it "should give concurrent writers distinct version numbers and exactly one active version" do
    writers = Array.new(5) do |index|
      in_thread do
        Secrets::WriteVersion.call(VaultSecret.find(secret.id), "secret.rotate", { value: "v#{index + 2}", created_by: "admin" })
      end
    end
    writers.each(&:join)

    expect(secret.versions.order(:version_number).pluck(:version_number)).to eq((1..6).to_a)
    expect(secret.versions.active.count).to eq(1)
    expect(secret.reload.current_version.version_number).to eq(6)
  end
end
