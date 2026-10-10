module LeaseSerializer
  module_function

  def call(lease)
    {
      id: lease.id,
      vaultSecretId: lease.vault_secret_id,
      serviceClientId: lease.service_client_id,
      grantedPermissions: lease.granted_permissions.join(","),
      issuedAt: lease.issued_at,
      expiresAt: lease.expires_at,
      revokedAt: lease.revoked_at,
      status: lease.effective_status,
      createdAt: lease.created_at,
      secretPath: lease.vault_secret.path,
      serviceClientName: lease.service_client.name
    }
  end
end
