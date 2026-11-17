import { MULTISIG_UI_CONFIG } from '@/config/multisig'

/**
 * Integration trace for dev builds with the multisig UI enabled. Callers pass only the allowed
 * fields (direction, messageType, slot, sequence, step, result, reason, phase): never payloads,
 * envelope JSON, keys, signatures, fingerprints, addresses or full ids.
 */
export function multisigDebug(
  event: string,
  fields?: Record<string, string | number | boolean>
): void {
  if (!MULTISIG_UI_CONFIG.enabled) return
  console.debug('[multisig]', event, fields)
}

export function shortId(value: string): string {
  return value.slice(-4)
}
