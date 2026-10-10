# The credential digest is deliberately omitted: the UI never needs it, and
# exposing it only helps an attacker confirm a guessed credential offline.
module ServiceClientSerializer
  module_function

  def call(client)
    {
      id: client.id,
      workspaceId: client.workspace_id,
      publicId: client.public_id,
      name: client.name,
      clientType: client.client_type,
      credentialPrefix: client.credential_prefix,
      status: client.status,
      expiresAt: client.expires_at,
      lastUsedAt: client.last_used_at,
      revokedAt: client.revoked_at,
      createdAt: client.created_at,
      updatedAt: client.updated_at
    }
  end
end
