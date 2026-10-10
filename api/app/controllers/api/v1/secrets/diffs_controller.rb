module Api
  module V1
    module Secrets
      class DiffsController < ApplicationController
        include SecretAccess

        rate_limit to: 30, within: 1.minute, with: -> { raise VaultError.new(:rate_limited) }

        def create
          secret = find_secret!
          authorize_value_read!(secret, "secret.diff")
          ensure_secret_active!(secret)
          versions = %i[versionAId versionBId].map { |key| find_version!(secret, params.require(key)) }

          values = versions.map(&:decrypt_value)
          diff = ::Secrets::LineDiff.call(*values)
          SecretAccessEvent.record!("secret.diff", secret: secret, secret_version_id: versions.last.id,
                                    reason_code: versions.map { |version| "v#{version.version_number}" }.join("→"))
          render_plaintext(diff_payload(versions, values, diff))
        end

        private

        def find_version!(secret, id)
          secret.versions.find_by(id: id) || raise(VaultError.new(:version_not_found, "version #{id} not found for this secret"))
        end

        def diff_payload(versions, values, diff)
          counts = diff.group_by { |line| line[:type] }.transform_values(&:size)
          {
            versionA: SecretVersionSerializer.call(versions.first), versionB: SecretVersionSerializer.call(versions.last),
            valueA: values.first, valueB: values.last, diff: diff,
            stats: { additions: counts.fetch("add", 0), removals: counts.fetch("remove", 0), context: counts.fetch("context", 0) }
          }
        end
      end
    end
  end
end
