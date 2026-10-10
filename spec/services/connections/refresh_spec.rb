require "rails_helper"

RSpec.describe Connections::Refresh do
  include ActiveJob::TestHelper

  let(:connection) { create(:integration_connection, adapter_key: "dhan_v1", refresh_after: 1.minute.ago) }

  before { bind_secrets(connection, "client_id" => "1100", "access_token" => "old-token") }

  def stub_provider(result) = allow(Providers::DhanV1).to receive(:refresh).and_return(result)

  def success(expires_at = 24.hours.from_now)
    Providers::Result.success("access_token" => { value: "new-token", expires_at: expires_at })
  end

  it "should store the new credential, reschedule the connection and audit success" do
    stub_provider(success)

    run = described_class.call(connection)

    connection.reload
    expect(run).to have_attributes(status: "succeeded", attempt_count: 1)
    expect(run.result_version.decrypt_value).to eq("new-token")
    expect(connection).to have_attributes(status: "active", refresh_generation: 1, refresh_lease_expires_at: nil)
    expect(connection.refresh_after).to be_within(4.minutes).of(connection.access_expires_at - 15.minutes)
    expect(SecretAccessEvent.where(action: "refresh.succeeded")).to exist
  end

  it "should refuse a second attempt while the lease is held" do
    connection.update!(refresh_lease_expires_at: 30.seconds.from_now)

    expect { described_class.call(connection) }.to raise_error(VaultError) { |error| expect(error.code).to eq(:rotation_in_progress) }
  end

  it "should replay an idempotent request instead of refreshing twice" do
    stub_provider(success)

    first = described_class.call(connection, idempotency_key: "abc")
    second = described_class.call(connection.reload, idempotency_key: "abc")

    expect(second).to eq(first)
    expect(Providers::DhanV1).to have_received(:refresh).once
  end

  it "should flag reauthorization on a permanent failure" do
    stub_provider(Providers::Result.failure("invalid_grant"))

    run = described_class.call(connection)

    expect(run).to have_attributes(status: "failed", error_code: "invalid_grant")
    expect(connection.reload).to be_reauth_required
  end

  it "should schedule a backed-off retry on a transient failure" do
    stub_provider(Providers::Result.failure("transient"))

    run = described_class.call(connection)

    expect(run).to have_attributes(status: "pending", error_code: "transient")
    expect(run.run_after).to be_within(5.seconds).of(30.seconds.from_now)
    expect(RefreshConnectionJob).to have_been_enqueued.with(connection.id, run.id)
    expect(connection.reload).to have_attributes(status: "active", last_error_code: "transient", refresh_lease_expires_at: nil)
  end

  it "should stop retrying and mark the connection errored after the attempt cap" do
    stub_provider(Providers::Result.failure("transient"))
    run = connection.rotation_runs.create!(operation: "refresh", status: "pending", attempt_count: described_class::MAX_ATTEMPTS - 1)

    described_class.call(connection, run: run)

    expect(run.reload).to have_attributes(status: "failed", error_code: "retries_exhausted")
    expect(connection.reload).to be_error
  end

  it "should discard a result when a newer attempt claimed the connection meanwhile" do
    allow(Providers::DhanV1).to receive(:refresh) do
      IntegrationConnection.where(id: connection.id).update_all("refresh_generation = refresh_generation + 1")
      success
    end

    run = described_class.call(connection)

    expect(run).to have_attributes(status: "cancelled", error_code: "stale_generation")
    expect(connection.bindings.find_by(purpose: "access_token").vault_secret.versions.count).to eq(1)
  end

  it "should release the lease and fail the run if something unexpected raises" do
    allow(Providers::DhanV1).to receive(:refresh).and_raise(RuntimeError, "bug")

    expect { described_class.call(connection) }.to raise_error(RuntimeError)
    expect(connection.reload.refresh_lease_expires_at).to be_nil
    expect(connection.rotation_runs.last).to have_attributes(status: "failed", error_code: "internal_error")
  end
end
