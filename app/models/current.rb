# Per-request context read by auditing, so callers never thread request metadata by hand.
class Current < ActiveSupport::CurrentAttributes
  attribute :principal, :request_id, :source_ip
end
