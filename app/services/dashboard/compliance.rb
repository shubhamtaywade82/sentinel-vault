module Dashboard
  # Rotation and expiry hygiene for non-revoked secrets.
  module Compliance
    ROTATION_ELIGIBLE_KINDS = %w[api_key access_token refresh_token client_secret connection_string private_key certificate].freeze
    STALE_AFTER_DAYS = 90
    EXPIRING_WITHIN = 7.days
    VIOLATION_LIMIT = 20

    module_function

    def call(workspace_id)
      secrets = Dashboard.scope(VaultSecret.where.not(status: "revoked"), workspace_id).includes(:current_version).to_a
      version_counts = SecretVersion.where(vault_secret_id: secrets.map(&:id)).group(:vault_secret_id).count
      violations = secrets.flat_map { |secret| violations_for(secret, version_counts.fetch(secret.id, 0)) }
      violating = violations.pluck(:secretId).uniq.size
      { summary: summary(secrets.size, violating),
        violations: violations.sort_by { |v| [ -v[:daysStale], v[:path] ] }.first(VIOLATION_LIMIT) }
    end

    def summary(total, violating)
      score = total.zero? ? 100 : ((total - violating) * 100.0 / total).round
      { totalSecrets: total, compliant: total - violating, violations: violating, complianceScore: score }
    end

    def violations_for(secret, version_count)
      activated = secret.current_version&.activated_at
      days_stale = activated ? ((Time.current - activated) / 1.day).floor : 0
      eligible = secret.kind.in?(ROTATION_ELIGIBLE_KINDS)
      kinds = []
      kinds << "stale_rotation" if eligible && activated && days_stale > STALE_AFTER_DAYS
      kinds << "never_rotated" if eligible && version_count == 1
      kinds << "expired_secret" if secret.expires_at&.past?
      kinds << "expiring_soon" if secret.expires_at&.between?(Time.current, EXPIRING_WITHIN.from_now)
      kinds.map do |kind|
        { secretId: secret.id, path: secret.path, kind: secret.kind, violation: kind, daysStale: days_stale,
          lastRotatedAt: activated, expiresAt: secret.expires_at }
      end
    end
  end
end
