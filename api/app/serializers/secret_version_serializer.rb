module SecretVersionSerializer
  module_function

  def call(version)
    {
      id: version.id,
      vaultSecretId: version.vault_secret_id,
      versionNumber: version.version_number,
      status: version.status,
      cryptoScheme: version.crypto_scheme,
      kmsKeyRef: version.kms_key_ref,
      createdBy: version.created_by,
      activatedAt: version.activated_at,
      retiredAt: version.retired_at,
      createdAt: version.created_at
    }
  end
end
