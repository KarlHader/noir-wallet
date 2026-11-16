import { parseKeyringCommand, type KeyringCommand } from '@/core/keyring/ports'
import { decodeChromeRuntimeCommand } from '@/infrastructure/keyring/multichain/chrome-runtime-codec'

const EXTENSION_PAGE_MULTICHAIN_OPERATIONS = new Set<KeyringCommand['operation']>([
  'credential.create'
])

export type MultichainExtensionCommandAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'invalid-command' | 'background-only' }

/** Keeps unreleased derive and signing capabilities behind Background-owned application flows. */
export function authorizeMultichainExtensionCommand(
  encodedCommand: unknown
): MultichainExtensionCommandAuthorization {
  let command: KeyringCommand
  try {
    command = parseKeyringCommand(decodeChromeRuntimeCommand(encodedCommand))
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid-command' })
  }

  if (!EXTENSION_PAGE_MULTICHAIN_OPERATIONS.has(command.operation)) {
    return Object.freeze({ allowed: false, reason: 'background-only' })
  }
  return Object.freeze({ allowed: true })
}
