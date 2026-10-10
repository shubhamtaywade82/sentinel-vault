# Makes "a grant or binding never crosses workspaces" a database invariant, so
# no writer (console, import, future job) can link a client to another tenant's
# secret. Each link row carries workspace_id, and composite foreign keys require
# both endpoints to share it.
class EnforceWorkspaceOnGrantsAndBindings < ActiveRecord::Migration[8.1]
  def change
    add_index :service_clients, %i[id workspace_id], unique: true
    add_index :vault_secrets, %i[id workspace_id], unique: true
    add_index :integration_connections, %i[id workspace_id], unique: true

    add_column :secret_access_grants, :workspace_id, :uuid
    add_column :connection_secret_bindings, :workspace_id, :uuid

    reversible do |dir|
      dir.up do
        execute <<~SQL
          UPDATE secret_access_grants g SET workspace_id = s.workspace_id FROM vault_secrets s WHERE s.id = g.vault_secret_id;
          UPDATE connection_secret_bindings b SET workspace_id = s.workspace_id FROM vault_secrets s WHERE s.id = b.vault_secret_id;
        SQL
      end
    end

    change_column_null :secret_access_grants, :workspace_id, false
    change_column_null :connection_secret_bindings, :workspace_id, false

    add_same_workspace_key :secret_access_grants, :service_client_id, :service_clients
    add_same_workspace_key :secret_access_grants, :vault_secret_id, :vault_secrets
    add_same_workspace_key :connection_secret_bindings, :integration_connection_id, :integration_connections
    add_same_workspace_key :connection_secret_bindings, :vault_secret_id, :vault_secrets
  end

  private

  def add_same_workspace_key(table, column, target)
    add_foreign_key table, target, column: [ column, :workspace_id ], primary_key: %i[id workspace_id],
                                   name: "fk_#{table}_#{column}_same_workspace"
  end
end
