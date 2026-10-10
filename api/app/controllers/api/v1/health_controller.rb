module Api
  module V1
    class HealthController < ApplicationController
      HEALTHCHECK_CONTEXT = { "purpose" => "healthcheck" }.freeze

      skip_before_action :authenticate!

      def live
        render json: { status: "alive", ts: Time.current }
      end

      # Provider availability is deliberately not checked: a broker outage must
      # not take the vault out of rotation.
      def ready
        checks = { db: check { ActiveRecord::Base.connection.select_value("SELECT 1") }, crypto: check { crypto_round_trip } }
        ready = checks.values.all?("ok")
        render json: { status: ready ? "ready" : "unready", **checks, ts: Time.current }, status: ready ? :ok : :service_unavailable
      end

      private

      def check
        yield
        "ok"
      rescue StandardError => e
        Rails.logger.error("[vault] readiness check failed: #{e.class}")
        "error"
      end

      def crypto_round_trip
        probe = SecureRandom.hex(8)
        raise "round trip mismatch" unless Encryption.decrypt(Encryption.encrypt(probe, HEALTHCHECK_CONTEXT), HEALTHCHECK_CONTEXT) == probe
      end
    end
  end
end
