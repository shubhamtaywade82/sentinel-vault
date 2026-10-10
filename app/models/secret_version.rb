class SecretVersion < ApplicationRecord
  belongs_to :vault_secret

  # Not an enum: "destroyed" would shadow ActiveRecord#destroyed?.
  STATUSES = %w[active retired destroyed].freeze

  scope :active, -> { where(status: "active") }

  validates :status, inclusion: { in: STATUSES }

  validates :version_number, numericality: { only_integer: true, greater_than: 0 }
  validates :ciphertext, :encrypted_data_key, :kms_key_ref, :crypto_scheme, :created_by, :activated_at, presence: true

  # Binds the ciphertext to this exact record; string values because AWS KMS
  # encryption contexts only accept strings.
  def self.encryption_context(secret, version_number)
    { "workspace_id" => secret.workspace_id, "vault_secret_id" => secret.id, "version_number" => version_number.to_s }
  end

  def decrypt_value
    sealed = Encryption::Sealed.new(ciphertext:, encrypted_data_key:, kms_key_ref:, crypto_scheme:)
    Encryption.decrypt(sealed, self.class.encryption_context(vault_secret, version_number))
  end
end
