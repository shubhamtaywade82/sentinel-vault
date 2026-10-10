module Providers
  # Static API keys have no provider-side refresh; a person rotates them.
  module ApiKeyStatic
    module_function

    def refreshable? = false

    def reauthorizable?(_credentials) = false

    def refresh(_connection, _credentials) = Result.failure("manual_rotation_required")
  end
end
