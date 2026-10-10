module Api
  module V1
    class WorkspacesController < ApplicationController
      before_action :require_admin!

      def index
        render json: { workspaces: Workspace.order(:slug).map { |workspace| WorkspaceSerializer.call(workspace) } }
      end

      def create
        workspace = Workspace.transaction do
          Workspace.create!(slug: params.require(:slug), name: params.require(:name)).tap do |created|
            SecretAccessEvent.record!("workspace.create", workspace_id: created.id)
          end
        end
        render json: { workspace: WorkspaceSerializer.call(workspace) }, status: :created
      end
    end
  end
end
