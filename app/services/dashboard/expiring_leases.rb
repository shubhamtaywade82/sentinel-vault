module Dashboard
  module ExpiringLeases
    WINDOW = 1.hour
    LIMIT = 10

    module_function

    def call(workspace_id)
      now = Time.current
      leases = SecretLease.where(status: "active", expires_at: ...WINDOW.from_now).includes(:vault_secret, :service_client)
      Dashboard.scope(leases.joins(:vault_secret), workspace_id, column: "vault_secrets.workspace_id")
               .order(:expires_at).limit(LIMIT).map do |lease|
        remaining = [ (lease.expires_at - now).floor, 0 ].max
        { leaseId: lease.id, secretPath: lease.vault_secret.path, secretName: lease.vault_secret.name,
          clientName: lease.service_client.name, expiresAt: lease.expires_at, secondsRemaining: remaining,
          status: remaining.positive? ? "expiring" : "expired" }
      end
    end
  end
end
