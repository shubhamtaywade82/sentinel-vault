module Api
  module V1
    module Admin
      class ServiceClientsController < ApplicationController
        before_action :require_admin!

        rate_limit to: 30, within: 1.minute, only: %i[rotate_credential revoke], with: -> { raise VaultError.new(:rate_limited) }

        def index
          clients = ServiceClient.includes(:workspace).order(created_at: :desc)
          clients = clients.where(workspace_id: params[:workspaceId]) if params[:workspaceId].present?
          grant_counts = SecretAccessGrant.where(service_client_id: clients.select(:id)).group(:service_client_id).count
          render json: { clients: clients.map { |client| list_item(client, grant_counts.fetch(client.id, 0)) } }
        end

        def create
          workspace = Workspace.find_by(id: params.require(:workspaceId)) || raise(VaultError.new(:workspace_not_found))
          client = workspace.service_clients.new(name: params.require(:name), client_type: params.require(:clientType), expires_at: requested_expiry)
          credential = ServiceClient.transaction do
            client.issue_credential!.tap { audit!("client.create", client) }
          end
          render_plaintext({ client: ServiceClientSerializer.call(client), credential: credential }, status: :created)
        end

        def rotate_credential
          client = find_client!
          credential = client.with_lock do
            raise VaultError.new(:conflict, "a revoked client cannot be re-credentialed") if client.revoked?

            client.issue_credential!.tap { audit!("client.rotate", client) }
          end
          render_plaintext({ client: ServiceClientSerializer.call(client), credential: credential })
        end

        def revoke
          client = find_client!
          client.with_lock do
            raise VaultError.new(:conflict, "client is already revoked") if client.revoked?

            client.update!(status: "revoked", revoked_at: Time.current)
            audit!("client.revoke", client)
          end
          render json: { client: ServiceClientSerializer.call(client) }
        end

        private

        def find_client! = ServiceClient.find_by(id: params[:id]) || raise(VaultError.new(:client_not_found))

        # The actor is the admin; the affected client is named in reason_code.
        def audit!(action, client) = SecretAccessEvent.record!(action, workspace_id: client.workspace_id, reason_code: client.public_id)

        def requested_expiry
          days = params[:expiresInDays]
          return if days.blank?

          days = Float(days, exception: false)
          raise VaultError.new(:validation_failed, "expiresInDays must be a positive number") unless days&.positive?

          days.days.from_now
        end

        def list_item(client, grants_count)
          ServiceClientSerializer.call(client).merge(workspaceSlug: client.workspace.slug, grantsCount: grants_count)
        end
      end
    end
  end
end
