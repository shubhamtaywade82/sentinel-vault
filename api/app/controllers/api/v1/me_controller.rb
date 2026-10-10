module Api
  module V1
    class MeController < ApplicationController
      ADMIN_IDENTITY = {
        id: "admin", publicId: "admin", name: "Vault Administrator", clientType: "worker",
        workspaceId: "", workspaceSlug: "all", status: "active", permissions: [ "admin" ]
      }.freeze

      def show
        return render(json: { client: ADMIN_IDENTITY, grants: [] }) if Current.principal.admin?

        client = Current.principal.client
        render json: { client: client_identity(client), grants: client.grants.includes(:vault_secret).map { |grant| grant_item(grant) } }
      end

      private

      def client_identity(client)
        {
          id: client.id, publicId: client.public_id, name: client.name, clientType: client.client_type,
          workspaceId: client.workspace_id, workspaceSlug: client.workspace.slug, status: client.status, permissions: []
        }
      end

      def grant_item(grant)
        { secretId: grant.vault_secret_id, secretPath: grant.vault_secret.path, secretName: grant.vault_secret.name, permissions: grant.permissions }
      end
    end
  end
end
