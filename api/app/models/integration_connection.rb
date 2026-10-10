class IntegrationConnection < ApplicationRecord
  ACCESS_TOKEN_PURPOSE = "access_token".freeze
  # Credentials a client may read through a connection; refresh tokens and TOTP
  # seeds stay inside the vault for the provider adapters only.
  READABLE_PURPOSES = [ ACCESS_TOKEN_PURPOSE ].freeze
  # Adapters the provider layer will implement; validated now so no connection
  # can be created that the refresh engine cannot later drive.
  ADAPTER_KEYS = %w[dhan_v1 oauth2_generic api_key_static].freeze

  belongs_to :workspace
  has_many :bindings, class_name: "ConnectionSecretBinding", dependent: :destroy

  enum :status, {
    active: "active", refreshing: "refreshing", reauth_required: "reauth_required", revoked: "revoked", error: "error"
  }, validate: true

  validates :provider_key, :auth_method, presence: true
  validates :adapter_key, inclusion: { in: ADAPTER_KEYS }

  def access_expired? = access_expires_at.present? && access_expires_at <= Time.current

  # Connections in the client's workspace bound to a secret it can read or refresh.
  scope :visible_to, lambda { |client|
    usable_secrets = client.grants.where("permissions && ARRAY['value:read','connection:refresh']::varchar[]").select(:vault_secret_id)
    where(workspace_id: client.workspace_id)
      .where(id: ConnectionSecretBinding.where(vault_secret_id: usable_secrets).select(:integration_connection_id))
  }
end
