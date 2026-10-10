module GrantSerializer
  module_function

  def call(grant)
    {
      id: grant.id,
      serviceClientId: grant.service_client_id,
      vaultSecretId: grant.vault_secret_id,
      permissions: grant.permissions.join(","),
      createdAt: grant.created_at,
      updatedAt: grant.updated_at
    }
  end

  def list_item(grant)
    call(grant).merge(
      serviceClientName: grant.service_client.name,
      secretPath: grant.vault_secret.path,
      secretName: grant.vault_secret.name
    )
  end
end
