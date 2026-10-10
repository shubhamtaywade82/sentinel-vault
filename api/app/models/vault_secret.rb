class VaultSecret < ApplicationRecord
  KINDS = %w[api_key access_token refresh_token client_secret totp_seed private_key certificate connection_string public_key].freeze
  CLASSIFICATIONS = %w[public internal confidential restricted].freeze

  belongs_to :workspace
  belongs_to :current_version, class_name: "SecretVersion", optional: true
  has_many :versions, class_name: "SecretVersion"
  has_many :grants, class_name: "SecretAccessGrant"
  has_many :bindings, class_name: "ConnectionSecretBinding"

  enum :status, { active: "active", rotating: "rotating", revoked: "revoked", expired: "expired", retired: "retired" }, validate: true

  validates :path, presence: true, uniqueness: { scope: :workspace_id }, format: { with: /\A\S+\z/, message: "must not contain whitespace" }
  validates :name, :environment, presence: true
  validates :kind, inclusion: { in: KINDS }
  validates :classification, inclusion: { in: CLASSIFICATIONS }

  # Terminal: retires the active version so no value can be read or written again.
  def revoke!
    with_lock do
      raise VaultError.new(:conflict, "secret is already revoked") if revoked?

      now = Time.current
      # update_all skips callbacks (SecretVersion has none) and validations; the
      # status check constraint still guards the value, and the audit row is below.
      versions.active.update_all(status: "retired", retired_at: now)
      update!(status: "revoked", revoked_at: now)
      SecretAccessEvent.record!("secret.revoke", secret: self)
    end
  end
end
