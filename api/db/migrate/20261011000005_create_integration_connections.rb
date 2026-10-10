class CreateIntegrationConnections < ActiveRecord::Migration[8.1]
  def change
    create_table :integration_connections, id: :uuid do |t|
      t.references :workspace, null: false, foreign_key: true, type: :uuid
      t.string :provider_key, null: false
      t.string :auth_method, null: false
      t.string :adapter_key, null: false
      t.string :provider_account_ref
      t.string :status, null: false, default: "active"
      t.datetime :access_expires_at
      t.datetime :refresh_after
      t.datetime :last_refreshed_at
      t.datetime :refresh_lease_expires_at
      t.integer :refresh_generation, null: false, default: 0
      t.string :last_error_code
      t.datetime :reauth_required_at
      t.timestamps
    end
    add_index :integration_connections, %i[status refresh_after]
    add_check_constraint :integration_connections, "status IN ('active','refreshing','reauth_required','revoked','error')", name: "integration_connections_status_check"

    create_table :connection_secret_bindings, id: :uuid do |t|
      t.references :integration_connection, null: false, foreign_key: true, type: :uuid, index: false
      t.references :vault_secret, null: false, foreign_key: true, type: :uuid
      t.string :purpose, null: false
      t.datetime :created_at, null: false
    end
    add_index :connection_secret_bindings, %i[integration_connection_id purpose], unique: true, name: "index_bindings_on_connection_and_purpose"
  end
end
