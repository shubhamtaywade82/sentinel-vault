class CreateSecretAccessGrants < ActiveRecord::Migration[8.1]
  PERMISSIONS = %w[metadata:read value:read version:create rotate revoke connection:refresh audit:read].freeze

  def change
    create_table :secret_access_grants, id: :uuid do |t|
      t.references :service_client, null: false, foreign_key: true, type: :uuid, index: false
      t.references :vault_secret, null: false, foreign_key: true, type: :uuid
      t.string :permissions, array: true, null: false, default: []
      t.timestamps
    end
    add_index :secret_access_grants, %i[service_client_id vault_secret_id], unique: true
    add_check_constraint :secret_access_grants,
      "cardinality(permissions) > 0 AND permissions <@ ARRAY[#{PERMISSIONS.map { |p| "'#{p}'" }.join(',')}]::varchar[]",
      name: "secret_access_grants_permissions_check"
  end
end
