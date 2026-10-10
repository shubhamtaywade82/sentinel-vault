class CreateServiceClients < ActiveRecord::Migration[8.1]
  def change
    create_table :service_clients, id: :uuid do |t|
      t.references :workspace, null: false, foreign_key: true, type: :uuid
      t.string :public_id, null: false, index: { unique: true }
      t.string :name, null: false
      t.string :client_type, null: false
      t.string :credential_digest, null: false, index: { unique: true }
      t.string :credential_prefix, null: false
      t.string :status, null: false, default: "active"
      t.datetime :expires_at
      t.datetime :last_used_at
      t.datetime :revoked_at
      t.timestamps
    end
    add_index :service_clients, %i[workspace_id name], unique: true
    add_check_constraint :service_clients, "client_type IN ('bot','app','gateway','cli','mcp','worker')", name: "service_clients_type_check"
    add_check_constraint :service_clients, "status IN ('active','revoked','expired')", name: "service_clients_status_check"
  end
end
