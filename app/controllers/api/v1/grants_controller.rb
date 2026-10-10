module Api
  module V1
    class GrantsController < ApplicationController
      before_action :require_admin!

      def index
        grants = SecretAccessGrant.includes(:service_client, :vault_secret).order(:created_at)
        grants = grants.joins(:vault_secret).where(vault_secrets: { workspace_id: params[:workspaceId] }) if params[:workspaceId].present?
        render json: { grants: grants.map { |grant| GrantSerializer.list_item(grant) } }
      end
    end
  end
end
