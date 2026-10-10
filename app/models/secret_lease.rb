# A time-boxed record of a client's intended access to a secret. Advisory:
# authorization is decided by grants alone, so a lease never widens access,
# and it may not claim permissions the client's grant does not hold.
class SecretLease < ApplicationRecord
  TTL_RANGE = (60..86_400)

  belongs_to :vault_secret
  belongs_to :service_client

  validates :granted_permissions, presence: true
  validate :permissions_within_grant

  before_validation on: :create do
    self.issued_at ||= Time.current
    self.status ||= "active"
  end

  scope :current, -> { where(status: "active").where(expires_at: Time.current..) }

  # Expiry is derived on read, so no background job has to flip statuses.
  def effective_status = status == "active" && expires_at <= Time.current ? "expired" : status

  def revoke!
    raise VaultError.new(:conflict, "lease is already #{effective_status}") unless effective_status == "active"

    update!(status: "revoked", revoked_at: Time.current)
  end

  private

  def permissions_within_grant
    return if service_client.nil? || vault_secret.nil?

    beyond = granted_permissions - service_client.permissions_for(vault_secret)
    errors.add(:granted_permissions, "exceed the client's grant: #{beyond.join(', ')}") if beyond.any?
  end
end
