module ConnectionSerializer
  module_function

  def call(connection)
    {
      id: connection.id,
      workspaceId: connection.workspace_id,
      providerKey: connection.provider_key,
      authMethod: connection.auth_method,
      adapterKey: connection.adapter_key,
      providerAccountRef: connection.provider_account_ref,
      status: connection.status,
      accessExpiresAt: connection.access_expires_at,
      refreshAfter: connection.refresh_after,
      lastRefreshedAt: connection.last_refreshed_at,
      refreshLeaseExpiresAt: connection.refresh_lease_expires_at,
      refreshGeneration: connection.refresh_generation,
      lastErrorCode: connection.last_error_code,
      reauthRequiredAt: connection.reauth_required_at,
      createdAt: connection.created_at,
      updatedAt: connection.updated_at
    }
  end

  def with_bindings(connection)
    call(connection).merge(bindings: connection.bindings.map { |binding| binding_item(binding) })
  end

  def binding_item(binding)
    {
      id: binding.id,
      connectionId: binding.integration_connection_id,
      vaultSecretId: binding.vault_secret_id,
      purpose: binding.purpose,
      secretPath: binding.vault_secret.path,
      secretName: binding.vault_secret.name
    }
  end
end
