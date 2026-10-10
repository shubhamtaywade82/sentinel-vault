module Dashboard
  # What each client can and cannot reach: the least-privilege view.
  module ClientPreview
    INACCESSIBLE_SAMPLE = 5

    module_function

    def call(workspace_id)
      secrets = Dashboard.scope(VaultSecret.all, workspace_id).order(:path).to_a
      Dashboard.scope(ServiceClient.all, workspace_id).includes(:grants).order(:name).map do |client|
        granted = client.grants.index_by(&:vault_secret_id)
        accessible, inaccessible = secrets.partition { |secret| granted.key?(secret.id) }
        { clientId: client.id, clientName: client.name, clientType: client.client_type, publicId: client.public_id,
          status: client.status, grantsCount: granted.size,
          accessibleSecrets: accessible.map { |secret| summary(secret).merge(permissions: granted[secret.id].permissions) },
          inaccessibleSecrets: inaccessible.first(INACCESSIBLE_SAMPLE).map { |secret| summary(secret) } }
      end
    end

    def summary(secret) = { secretId: secret.id, path: secret.path, name: secret.name, kind: secret.kind }
  end
end
