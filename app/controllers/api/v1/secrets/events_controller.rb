module Api
  module V1
    module Secrets
      class EventsController < ApplicationController
        include SecretAccess

        DEFAULT_LIMIT = 50
        MAX_LIMIT = 200

        def index
          secret = find_secret!
          authorize_secret!(secret, "audit:read")
          events = SecretAccessEvent.where(vault_secret_id: secret.id).includes(:actor_client, :vault_secret)
                                    .order(created_at: :desc).limit(limit)
          render json: { events: events.map { |event| AuditEventSerializer.call(event) } }
        end

        private

        def limit = params.fetch(:limit, DEFAULT_LIMIT).to_i.clamp(1, MAX_LIMIT)
      end
    end
  end
end
