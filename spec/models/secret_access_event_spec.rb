require "rails_helper"

RSpec.describe SecretAccessEvent do
  let!(:event) { described_class.record!("secret.reveal") }

  it "should be read-only once written" do
    expect { event.update!(outcome: "denied") }.to raise_error(ActiveRecord::ReadOnlyRecord)
  end

  it "should reject updates at the database level" do
    expect { described_class.where(id: event.id).update_all(outcome: "denied") }
      .to raise_error(ActiveRecord::StatementInvalid, /append-only/)
  end

  it "should reject deletes at the database level" do
    expect { described_class.where(id: event.id).delete_all }.to raise_error(ActiveRecord::StatementInvalid, /append-only/)
  end

  it "should raise audit_persist_failed when the write fails" do
    expect { described_class.record!("x", outcome: "not-an-outcome") }
      .to raise_error(VaultError) { |error| expect(error.code).to eq(:audit_persist_failed) }
  end
end
