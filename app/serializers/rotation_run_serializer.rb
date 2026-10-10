module RotationRunSerializer
  module_function

  def call(run)
    {
      id: run.id,
      connectionId: run.integration_connection_id,
      vaultSecretId: run.vault_secret_id,
      operation: run.operation,
      status: run.status,
      attemptCount: run.attempt_count,
      idempotencyKey: run.idempotency_key,
      runAfter: run.run_after,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      resultVersionId: run.result_version_id,
      errorCode: run.error_code,
      correlationId: run.correlation_id,
      createdAt: run.created_at
    }
  end
end
