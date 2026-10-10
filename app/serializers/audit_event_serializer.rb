module AuditEventSerializer
  module_function

  def call(event)
    {
      id: event.id,
      workspaceId: event.workspace_id,
      actorClientId: event.actor_client_id,
      actorClientName: event.actor_client&.name,
      vaultSecretId: event.vault_secret_id,
      secretPath: event.vault_secret&.path,
      secretVersionId: event.secret_version_id,
      action: event.action,
      outcome: event.outcome,
      reasonCode: event.reason_code,
      requestId: event.request_id,
      sourceIp: event.source_ip,
      createdAt: event.created_at
    }
  end
end
