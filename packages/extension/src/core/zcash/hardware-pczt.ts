import { TimeoutError } from '@/lib/async-utils'
import { formatHardwareSigningError } from '@/lib/hardware-signing-error'
import { isTransactionSubmissionUnknown } from './transfer-result'

const STAGE_CODES = {
  'parse-wallet': 'HW-PCZT-01',
  'parse-device': 'HW-PCZT-02',
  combine: 'HW-PCZT-03',
  'prove-send': 'HW-PCZT-04',
  prepare: 'HW-PCZT-05',
  record: 'HW-PCZT-06',
  'apply-signatures': 'HW-PCZT-07'
} as const

export type HardwarePcztStage = keyof typeof STAGE_CODES
export function toHardwarePcztError(stage: HardwarePcztStage, error: unknown): Error {
  // Preserve uncertain submission outcomes so callers never offer a second payment.
  if (error instanceof TimeoutError || isTransactionSubmissionUnknown(error)) return error
  if (error instanceof Error && /^\[HW-PCZT-0[1-7]\]/.test(error.message)) return error
  return new Error(`[${STAGE_CODES[stage]}] ${formatHardwareSigningError(error)}`)
}

interface HardwarePczt<T> {
  combine(other: T): T
  free(): void
}

export async function proveHardwarePczt<T extends HardwarePczt<T>>(input: {
  readonly readFull: () => T
  readonly readSigned: () => T
  /** Takes ownership of the combined WASM object, including on failure. */
  readonly proveAndSend: (combined: T) => Promise<string>
}): Promise<string> {
  let stage: HardwarePcztStage = 'parse-wallet'
  let full: T | undefined
  let signed: T | undefined
  try {
    full = input.readFull()
    stage = 'parse-device'
    signed = input.readSigned()
    stage = 'combine'
    const combined = full.combine(signed)
    stage = 'prove-send'
    return await input.proveAndSend(combined)
  } catch (error) {
    throw toHardwarePcztError(stage, error)
  } finally {
    signed?.free()
    full?.free()
  }
}
