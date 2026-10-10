class CreateRotationRunsAndLeases < ActiveRecord::Migration[8.1]
  def change
    create_table :rotation_runs, id: :uuid do |t|
      t.references :integration_connection, foreign_key: true, type: :uuid
      t.references :vault_secret, foreign_key: true, type: :uuid
      t.references :result_version, foreign_key: { to_table: :secret_versions }, type: :uuid
      t.string :operation, null: false
      t.string :status, null: false, default: "pending"
      t.integer :attempt_count, null: false, default: 0
      t.string :idempotency_key, null: false, index: { unique: true }
      t.datetime :run_after, null: false
      t.datetime :started_at
      t.datetime :completed_at
      t.string :error_code
      t.string :lease_token
      t.datetime :lease_expires_at
      t.string :correlation_id
      t.datetime :created_at, null: false
    end
    add_check_constraint :rotation_runs, "status IN ('pending','running','succeeded','failed','cancelled')", name: "rotation_runs_status_check"

    create_table :secret_leases, id: :uuid do |t|
      t.references :vault_secret, null: false, foreign_key: true, type: :uuid
      t.references :service_client, null: false, foreign_key: true, type: :uuid
      t.string :granted_permissions, array: true, null: false, default: []
      t.datetime :issued_at, null: false
      t.datetime :expires_at, null: false
      t.datetime :revoked_at
      t.string :status, null: false, default: "active"
      t.datetime :created_at, null: false
    end
    add_check_constraint :secret_leases, "status IN ('active','expired','revoked')", name: "secret_leases_status_check"
  end
end
