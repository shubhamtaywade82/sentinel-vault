module Api
  module V1
    module Internal
      # Manual trigger for the sweep that RefreshSweepJob runs every minute.
      class WatchdogsController < ApplicationController
        before_action :require_admin!

        rate_limit to: 6, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        def create
          render json: ::Connections::Sweep.call
        end
      end
    end
  end
end
