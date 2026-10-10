module Api
  module V1
    class SecretsController < ApplicationController
      include SecretAccess

      before_action :require_admin!, only: :create

      def index
        secrets = visible_secrets.includes(:current_version).order(updated_at: :desc).to_a
        counts = SecretVersion.where(vault_secret_id: secrets.map(&:id)).group(:vault_secret_id).count
        render json: { secrets: secrets.map { |secret| SecretSerializer.list_item(secret, version_count: counts.fetch(secret.id, 0)) } }
      end

      def show
        secret = find_secret!
        authorize_secret!(secret)
        versions = secret.versions.order(version_number: :desc).map { |version| SecretVersionSerializer.call(version) }
        render json: { secret: SecretSerializer.call(secret).merge(versions: versions) }
      end

      def create
        workspace = Workspace.find_by(id: params.require(:workspaceId)) || raise(VaultError.new(:workspace_not_found))
        secret = VaultSecret.transaction do
          workspace.vault_secrets.create!(secret_attributes).tap do |created|
            ::Secrets::WriteVersion.call(created, "secret.create", { value: params.require(:value), created_by: "admin", **expiry_attributes })
          end
        end
        render json: { secret: SecretSerializer.call(secret), version: SecretVersionSerializer.call(secret.current_version) }, status: :created
      end

      private

      def visible_secrets
        return admin_scope if Current.principal.admin?

        client = Current.principal.client
        client.workspace.vault_secrets.where(id: client.grants.select(:vault_secret_id))
      end

      def admin_scope
        params[:workspaceId].present? ? VaultSecret.where(workspace_id: params[:workspaceId]) : VaultSecret.all
      end

      def secret_attributes
        {
          path: params.require(:path),
          name: params.require(:name),
          kind: params.require(:kind),
          classification: params[:classification].presence || "confidential",
          environment: params[:environment].presence || "production",
          provider: params[:provider].presence
        }
      end
    end
  end
end
