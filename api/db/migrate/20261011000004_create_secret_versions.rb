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
    add_foreign_key :vault_secrets, :secret_versions, column: :current_version_id
  end
end
