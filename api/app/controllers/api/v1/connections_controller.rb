module Api
  module V1
    class ConnectionsController < ApplicationController
      before_action :require_admin!, only: :create

      def index
        connections = scoped_connections.includes(bindings: :vault_secret).order(created_at: :desc).to_a
        connections.select! { |connection| connection.visible_to?(Current.principal.client) } unless Current.principal.admin?
        render json: { connections: connections.map { |connection| ConnectionSerializer.with_bindings(connection) } }
      end

      def create
        workspace = Workspace.find_by(id: params.require(:workspaceId)) || raise(VaultError.new(:workspace_not_found))
        connection = IntegrationConnection.transaction do
          workspace.integration_connections.create!(connection_attributes).tap do |created|
            create_bindings!(created, workspace)
            SecretAccessEvent.record!("connection.create", workspace_id: workspace.id, reason_code: created.id)
          end
        end
        render json: { connection: ConnectionSerializer.with_bindings(connection) }, status: :created
      end

      private

      def scoped_connections
        return IntegrationConnection.where(workspace_id: Current.principal.client.workspace_id) unless Current.principal.admin?

        params[:workspaceId].present? ? IntegrationConnection.where(workspace_id: params[:workspaceId]) : IntegrationConnection.all
      end

      def connection_attributes
        {
          provider_key: params.require(:providerKey), auth_method: params.require(:authMethod),
          adapter_key: params.require(:adapterKey), provider_account_ref: params[:providerAccountRef].presence,
          access_expires_at: parse_time(:accessExpiresAt), refresh_after: parse_time(:refreshAfter)
        }
      end

      def create_bindings!(connection, workspace)
        bindings = params.require(:bindings)
        raise VaultError.new(:validation_failed, "at least one binding is required") unless bindings.is_a?(Array) && bindings.any?

        bindings.each do |binding|
          secret = workspace.vault_secrets.find_by(id: binding[:secretId])
          raise VaultError.new(:validation_failed, "binding secrets must belong to the connection's workspace") unless secret

          connection.bindings.create!(vault_secret: secret, purpose: binding[:purpose].to_s.strip)
        end
      end

      def parse_time(key)
        return if params[key].blank?

        Time.iso8601(params[key])
      rescue ArgumentError
        raise VaultError.new(:validation_failed, "#{key} is not a valid ISO 8601 time")
      end
    end
  end
end
