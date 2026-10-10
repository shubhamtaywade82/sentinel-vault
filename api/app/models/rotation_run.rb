class RotationRun < ApplicationRecord
  OPERATIONS = %w[refresh reauthorize recover].freeze

  belongs_to :integration_connection, optional: true
  belongs_to :vault_secret, optional: true
  belongs_to :result_version, class_name: "SecretVersion", optional: true

  enum :status, { pending: "pending", running: "running", succeeded: "succeeded", failed: "failed", cancelled: "cancelled" },
       validate: true

  validates :operation, inclusion: { in: OPERATIONS }
  validates :idempotency_key, presence: true, uniqueness: true

  before_validation on: :create do
    self.idempotency_key ||= "#{operation}-#{SecureRandom.uuid}"
    self.correlation_id ||= SecureRandom.uuid
    self.run_after ||= Time.current
  end
end
