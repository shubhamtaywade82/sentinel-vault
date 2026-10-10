class CreateSecretAccessEvents < ActiveRecord::Migration[8.1]
  def change
    # Audit rows keep plain ids, not foreign keys: deleting a grant or client
    # must never cascade into, or be blocked by, the audit trail.
    create_table :secret_access_events, id: :uuid do |t|
      t.uuid :workspace_id
      t.uuid :actor_client_id
      t.uuid :vault_secret_id
      t.uuid :secret_version_id
      t.string :action, null: false
      t.string :outcome, null: false, default: "success"
      t.string :reason_code
      t.string :request_id
      t.string :source_ip
      t.datetime :created_at, null: false
    end
    add_index :secret_access_events, %i[workspace_id created_at]
    add_index :secret_access_events, %i[vault_secret_id created_at]
    add_index :secret_access_events, :action
    add_check_constraint :secret_access_events, "outcome IN ('success','denied','error')", name: "secret_access_events_outcome_check"

    # Append-only at the database level so no application bug can rewrite history.
    reversible do |dir|
      dir.up do
        execute <<~SQL
          CREATE FUNCTION secret_access_events_append_only() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'secret_access_events is append-only';
          END;
          $$ LANGUAGE plpgsql;

          CREATE TRIGGER secret_access_events_no_mutation
            BEFORE UPDATE OR DELETE ON secret_access_events
            FOR EACH ROW EXECUTE FUNCTION secret_access_events_append_only();
        SQL
      end
      dir.down do
        execute <<~SQL
          DROP TRIGGER secret_access_events_no_mutation ON secret_access_events;
          DROP FUNCTION secret_access_events_append_only();
        SQL
      end
    end
  end
end
