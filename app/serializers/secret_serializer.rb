module SecretSerializer
  module_function

  def call(secret)
    {
      id: secret.id,
      workspaceId: secret.workspace_id,
      path: secret.path,
      name: secret.name,
      kind: secret.kind,
      classification: secret.classification,
      environment: secret.environment,
      provider: secret.provider,
      status: secret.status,
      expiresAt: secret.expires_at,
      revokedAt: secret.revoked_at,
      currentVersionId: secret.current_version_id,
      createdAt: secret.created_at,
      updatedAt: secret.updated_at
    }
  end

  def list_item(secret, version_count:)
    call(secret).merge(currentVersionNumber: secret.current_version&.version_number, versionCount: version_count)
  end
end
