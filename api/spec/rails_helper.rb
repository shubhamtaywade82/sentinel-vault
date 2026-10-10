require "spec_helper"
require "securerandom"
require "base64"
ENV["RAILS_ENV"] ||= "test"

# Fresh secrets per run, set before boot so dotenv never supplies the developer's.
ENV["VAULT_ADMIN_TOKEN"] = SecureRandom.hex(32)
ENV["VAULT_KMS_PROVIDER"] = "local"
ENV["VAULT_MASTER_KEY"] = Base64.strict_encode64(SecureRandom.random_bytes(32))

require_relative "../config/environment"
abort("The Rails environment is running in production mode!") if Rails.env.production?
require "rspec/rails"
require "webmock/rspec"

Rails.root.glob("spec/support/**/*.rb").sort.each { |file| require file }

begin
  ActiveRecord::Migration.maintain_test_schema!
rescue ActiveRecord::PendingMigrationError => e
  abort e.to_s.strip
end

RSpec.configure do |config|
  config.use_transactional_fixtures = true
  config.filter_rails_from_backtrace!
  config.include FactoryBot::Syntax::Methods
  config.include ActiveSupport::Testing::TimeHelpers
  config.include ApiHelpers, type: :request
  config.before { Rails.cache.clear }
  # Requests and jobs reset Current via the Rails executor; plain specs do not.
  config.after { Current.reset }
end
