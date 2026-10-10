module Dashboard
  module Stats
    EXPIRING_LIMIT = 6

    module_function

    def call(workspace_id)
      connections = Dashboard.scope(IntegrationConnection.all, workspace_id)
      clients = Dashboard.scope(ServiceClient.all, workspace_id)
      {
        totalSecrets: Dashboard.scope(VaultSecret.all, workspace_id).count,
        activeConnections: connections.active.count,
        pendingRotations: Dashboard.scope(RotationRun.where(status: %w[pending running]).joins(:integration_connection), workspace_id,
                                          column: "integration_connections.workspace_id").count,
        reauthRequired: connections.reauth_required.count,
        auditEvents24h: Dashboard.scope(SecretAccessEvent.where(created_at: 24.hours.ago..), workspace_id).count,
        activeClients: clients.active.count,
        totalClients: clients.count,
        totalWorkspaces: Workspace.count,
        expiringSoon: expiring_soon(workspace_id)
      }
    end

    def expiring_soon(workspace_id)
      now = Time.current
      connections = Dashboard.scope(IntegrationConnection.where(access_expires_at: now..), workspace_id)
                             .order(:access_expires_at).limit(EXPIRING_LIMIT).map do |connection|
        { id: connection.id, kind: "connection", ref: [ connection.provider_key, connection.provider_account_ref ].compact.join("/"),
          expiresAt: connection.access_expires_at, status: connection.status }
      end
      secrets = Dashboard.scope(VaultSecret.where(expires_at: now..), workspace_id).order(:expires_at).limit(EXPIRING_LIMIT).map do |secret|
        { id: secret.id, kind: "secret", ref: secret.path, expiresAt: secret.expires_at, status: secret.status }
      end
      (connections + secrets).sort_by { |item| item[:expiresAt] }.first(EXPIRING_LIMIT)
    end
  end
end
