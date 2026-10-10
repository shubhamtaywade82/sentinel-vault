module Api
  module V1
    module Connections
      class StatusesController < ApplicationController
        include ConnectionAccess

        def show
          render json: { connection: ConnectionSerializer.call(find_connection!) }
        end
      end
    end
  end
end
