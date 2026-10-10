// POST /api/v1/admin/keys/rotate — admin-only. Rotates the in-app KMS master
// key: generates a new version, wraps it with the root-of-trust, marks it
// active, retires the old. Existing ciphertext stays decryptable (retired
// keys are kept); new writes use the new active version. Returns the new
// kmsKeyRef. Does NOT re-wrap existing data keys — run the re-wrap migration
// job separately to move old data keys to the new key.
import { handle, json, adminOrThrow, getRequestId } from '@/lib/vault/api-helpers'
import { rotateMasterKey } from '@/lib/vault/kms'
import { recordEventCritical } from '@/lib/vault/audit'

export const POST = handle(
  async (req) => {
    await adminOrThrow(req)
    const requestId = getRequestId(req)
    const newKmsKeyRef = await rotateMasterKey()

    // Key rotation is a privileged security operation — audit fail-closed.
    await recordEventCritical({
      action: 'key.rotate',
      outcome: 'success',
      reasonCode: newKmsKeyRef,
      requestId,
    })

    return json({ kmsKeyRef: newKmsKeyRef, message: 'Master key rotated. Run the re-wrap migration to move existing data keys to the new key.' })
  },
  // Tight rate limit — rotating the KMS master key is the most privileged
  // crypto operation in the vault. 30 req/min per (token, IP) key to make a
  // rapid key-rotation storm non-viable.
  { rateLimitOpts: { requestsPerMinute: 30, burst: 30 } },
)
