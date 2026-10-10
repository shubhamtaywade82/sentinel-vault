module Api
  module V1
    class RotationRunsController < ApplicationController
      DEFAULT_LIMIT = 50
      MAX_LIMIT = 500

      before_action :require_admin!

      def index
        runs = RotationRun.order(created_at: :desc).limit(params.fetch(:limit, DEFAULT_LIMIT).to_i.clamp(1, MAX_LIMIT))
        runs = runs.where(status: params[:status]) if params[:status].present?
        runs = runs.where(integration_connection_id: params[:connectionId]) if params[:connectionId].present?
        render json: { runs: runs.map { |run| RotationRunSerializer.call(run) } }
      end

      def show
        run = RotationRun.find_by(id: params[:id]) || raise(VaultError.new(:resource_not_found, "rotation run not found"))
        render json: { run: RotationRunSerializer.call(run) }
      end
    end
  end
end
