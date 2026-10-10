class CreateVaultSecrets < ActiveRecord::Migration[8.1]
  KINDS = %w[api_key access_token refresh_token client_secret totp_seed private_key certificate connection_string public_key].freeze

  def change
    create_table :vault_secrets, id: :uuid do |t|
      t.references :workspace, null: false, foreign_key: true, type: :uuid
      t.string :path, null: false
      t.string :name, null: false
      t.string :kind, null: false
      t.string :classification, null: false, default: "confidential"
      t.string :environment, null: false, default: "production"
      t.string :provider
      t.string :status, null: false, default: "active"
      t.datetime :expires_at
      t.datetime :revoked_at
      t.uuid :current_version_id
      t.timestamps
    end
    add_index :vault_secrets, %i[workspace_id path], unique: true
    add_check_constraint :vault_secrets, "kind IN (#{KINDS.map { |k| "'#{k}'" }.join(',')})", name: "vault_secrets_kind_check"
    add_check_constraint :vault_secrets, "classification IN ('public','internal','confidential','restricted')", name: "vault_secrets_classification_check"
    add_check_constraint :vault_secrets, "status IN ('active','rotating','revoked','expired','retired')", name: "vault_secrets_status_check"
  end
end
