# Fail closed: refuse to boot without vault secrets. Docker image builds set
# SECRET_KEY_BASE_DUMMY and never serve traffic, so they are exempt.
Rails.application.config.after_initialize do
  VaultConfig.validate! unless ENV["SECRET_KEY_BASE_DUMMY"]
end
