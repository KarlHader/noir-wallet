import { forwardKeyringRpcToOffscreen } from '@/core/worker/client'
import type { CompatibilityWorkerHost } from '@/infrastructure/keyring/migration'
import { parseCompatibilityWorkerResult } from '@/infrastructure/keyring/migration/compatibility-worker-protocol'
import {
  parseKeystoneZcashVerificationResult,
  type KeystoneZcashVerificationInput,
  type KeystoneZcashVerificationPort
} from '@/infrastructure/keyring/migration'

export class OffscreenCompatibilityWorkerPort {
  async migrate(input: Parameters<CompatibilityWorkerHost['migrate']>[0], timeoutMs?: number) {
    const result = await forwardKeyringRpcToOffscreen<unknown>('compatibility.migrate', {
      input,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    })
    return parseCompatibilityWorkerResult(result)
  }
}

export class OffscreenKeystoneZcashVerificationPort implements KeystoneZcashVerificationPort {
  async verifyZcash(input: KeystoneZcashVerificationInput) {
    const result = await forwardKeyringRpcToOffscreen<unknown>('keystone.verify-zcash', { input })
    return parseKeystoneZcashVerificationResult(result)
  }
}
