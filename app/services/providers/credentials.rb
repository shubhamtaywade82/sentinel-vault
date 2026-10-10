module Providers
  # A connection's bound secrets, decrypted only when an adapter asks for one,
  # so plaintext an adapter does not need is never produced.
  class Credentials
    def initialize(connection)
      @bindings = connection.bindings.includes(vault_secret: :current_version).index_by(&:purpose)
      @values = {}
    end

    def bound?(purpose) = @bindings.key?(purpose)

    def [](purpose)
      return @values[purpose] if @values.key?(purpose)

      version = @bindings[purpose]&.vault_secret&.current_version
      @values[purpose] = version&.decrypt_value
    end
  end
end
