class CreateSecretVersions < ActiveRecord::Migration[8.1]
  def change
    create_table :secret_versions, id: :uuid do |t|
      t.references :vault_secret, null: false, foreign_key: true, type: :uuid, index: false
      t.integer :version_number, null: false
      t.text :ciphertext, null: false
      t.text :encrypted_data_key, null: false
      t.string :kms_key_ref, null: false
      t.string :crypto_scheme, null: false
      t.string :status, null: false, default: "active"
      t.string :created_by, null: false
      t.datetime :activated_at, null: false
      t.datetime :retired_at
      t.datetime :created_at, null: false
    end
    add_index :secret_versions, %i[vault_secret_id version_number], unique: true
    # At most one active version per secret, enforced even under concurrent writers.
    add_index :secret_versions, :vault_secret_id, unique: true, where: "status = 'active'", name: "index_secret_versions_one_active"
    add_check_constraint :secret_versions, "status IN ('active','retired','destroyed')", name: "secret_versions_status_check"
    add_check_constraint :secret_versions, "version_number > 0", name: "secret_versions_number_check"
    # Composite key: the current version must exist AND belong to this same secret.
    add_index :secret_versions, %i[id vault_secret_id], unique: true
    add_foreign_key :vault_secrets, :secret_versions, column: %i[current_version_id id], primary_key: %i[id vault_secret_id],
                                                      name: "fk_vault_secrets_current_version_same_secret"
  end
end
