import type { KeyDomainSource } from '@/core/keyring/domain'
import type { HardwareCredentialMetadata } from '@/core/keyring/domain/hardware-credential'

type EvmExecutionKeySource =
  | Readonly<{ kind: 'software' | 'hardware' }>
  | Pick<Extract<KeyDomainSource, { kind: 'private-key' }>, 'kind' | 'chainFamily'>

export function supportsEvmPrivateExecution(
  source: EvmExecutionKeySource | null | undefined
): boolean {
  return (
    source?.kind === 'software' ||
    (source?.kind === 'private-key' && source.chainFamily === 'eip155')
  )
}

type ConfidentialShieldKeySource =
  | EvmExecutionKeySource
  | Readonly<{ kind: 'hardware'; hardware: HardwareCredentialMetadata }>
  | Extract<KeyDomainSource, { kind: 'hardware' }>

export function supportsEvmConfidentialShield(
  source: ConfidentialShieldKeySource | null | undefined
): boolean {
  if (source?.kind !== 'hardware') return supportsEvmPrivateExecution(source)
  const hardware = 'hardware' in source ? source.hardware : source
  return (
    'vendor' in hardware &&
    (hardware.vendor === 'ledger' || hardware.vendor === 'keystone') &&
    hardware.capabilities.includes('evm')
  )
}

export function supportsLedgerNativeZecConfidentialSwap(
  source: ConfidentialShieldKeySource | null | undefined
): boolean {
  if (source?.kind !== 'hardware') return false
  const hardware = 'hardware' in source ? source.hardware : source
  return (
    'vendor' in hardware &&
    hardware.vendor === 'ledger' &&
    hardware.capabilities.includes('zcash') &&
    hardware.capabilities.includes('evm')
  )
}
