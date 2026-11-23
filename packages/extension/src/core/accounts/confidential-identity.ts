import type { KeyDomainSource } from '@/core/keyring/domain'
import { supportsEvmPrivateExecution } from '@/core/chains/evm/execution-capability'
import {
  supportsNearPrivateExecution,
  type NearPrivateExecutionWalletSource
} from '@/core/chains/near/execution-capability'

export type ConfidentialIdentityWalletSource =
  | KeyDomainSource
  | NearPrivateExecutionWalletSource
  | Readonly<{
      kind: 'hardware'
      hardware: Readonly<{
        vendor: string
        capabilities: readonly string[]
      }>
    }>

export type ConfidentialIdentityKind = 'evm' | 'near' | 'near-ledger' | 'unavailable'

export interface ConfidentialIdentityAccount {
  readonly walletSource: ConfidentialIdentityWalletSource
  readonly accountIndex: number
}

export interface ConfidentialIdentity {
  readonly kind: ConfidentialIdentityKind
}

function ledgerCapabilities(source: ConfidentialIdentityWalletSource): readonly string[] | null {
  if (source.kind !== 'hardware') return null
  if ('hardware' in source && source.hardware) {
    return source.hardware.vendor === 'ledger' ? source.hardware.capabilities : null
  }
  if ('vendor' in source && 'capabilities' in source && source.vendor === 'ledger') {
    return source.capabilities
  }
  return null
}

function isNearLedgerAccount(source: ConfidentialIdentityWalletSource): boolean {
  return ledgerCapabilities(source)?.includes('near') === true
}

export function resolveConfidentialIdentity(
  account: ConfidentialIdentityAccount | null | undefined
): ConfidentialIdentity {
  if (!account) return Object.freeze({ kind: 'unavailable' })
  const { walletSource, accountIndex } = account
  if (supportsEvmPrivateExecution(walletSource)) {
    return Object.freeze({ kind: 'evm' })
  }
  if (
    supportsNearPrivateExecution(
      walletSource.kind === 'private-key'
        ? {
            kind: 'private-key',
            chainFamily: walletSource.chainFamily,
            accountIndex
          }
        : walletSource
    )
  ) {
    return Object.freeze({ kind: 'near' })
  }
  if (isNearLedgerAccount(walletSource)) {
    return Object.freeze({ kind: 'near-ledger' })
  }
  return Object.freeze({ kind: 'unavailable' })
}
