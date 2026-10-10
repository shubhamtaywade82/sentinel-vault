class ServiceClient < ApplicationRecord
  CREDENTIAL_PREFIX = "vlt_live_".freeze
  TYPES = %w[bot app gateway cli mcp worker].freeze

  belongs_to :workspace
  has_many :grants, class_name: "SecretAccessGrant"

  enum :status, { active: "active", revoked: "revoked", expired: "expired" }, validate: true

  validates :name, presence: true, uniqueness: { scope: :workspace_id }
  validates :client_type, inclusion: { in: TYPES }
  validates :public_id, :credential_digest, :credential_prefix, presence: true

  before_validation { self.public_id ||= "clt_#{SecureRandom.hex(8)}" }

  def self.digest(credential) = Digest::SHA256.hexdigest(credential)

  # The usable client holding this credential, or nil. Only digests are stored,
  # so a database leak never yields working credentials.
  def self.authenticate(credential)
    client = includes(:workspace).find_by(credential_digest: digest(credential))
    return unless client&.usable?

    client.update_column(:last_used_at, Time.current)
    client
  end

  def usable?
    active? && revoked_at.nil? && (expires_at.nil? || expires_at.future?) && workspace.active?
  end

  # Replaces the credential and returns the new plaintext; it is never retrievable again.
  def issue_credential!
    credential = "#{CREDENTIAL_PREFIX}#{SecureRandom.hex(32)}"
    update!(credential_digest: self.class.digest(credential), credential_prefix: credential.first(10))
    credential
  end

  def rotate_credential!
    with_lock do
      raise VaultError.new(:conflict, "a revoked client cannot be re-credentialed") if revoked?

      issue_credential!.tap { audit!("client.rotate") }
    end
  end

  # Terminal: a revoked client can never be re-credentialed.
  def revoke!
    with_lock do
      raise VaultError.new(:conflict, "client is already revoked") if revoked?

      update!(status: "revoked", revoked_at: Time.current)
      audit!("client.revoke")
    end
  end

  # The actor is whoever is authenticated; this client is the subject, named in reason_code.
  def audit!(action) = SecretAccessEvent.record!(action, workspace_id: workspace_id, reason_code: public_id)

  def permissions_for(secret)
    grants.find_by(vault_secret_id: secret.id)&.permissions || []
  end
end
