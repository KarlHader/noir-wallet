import type { ChainId } from '@/core/chains/domain'

export const PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION = 1 as const
export const PEARL_DEFAULT_GAP_LIMIT = 20
export const PEARL_MAXIMUM_GAP_LIMIT = 100
export const PEARL_DEFAULT_MAXIMUM_ADDRESSES_PER_TARGET = 200
export const PEARL_MAXIMUM_ADDRESSES_PER_TARGET = 2_000

export interface DerivePearlAddressInput {
  readonly chainId: ChainId | string
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
}

export interface DerivePearlAddressesInput {
  readonly chainId: ChainId | string
  readonly accountIndex: number
  readonly change: boolean
  readonly startAddressIndex: number
  readonly count: number
}

export interface DerivedPearlAddress {
  readonly chainId: string
  readonly address: string
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly derivationPath: string
  readonly publicKey: string
  readonly masterFingerprint: string
  readonly scriptPubKey: string
  readonly addressScheme: 'pearl_p2tr'
  readonly derivationScheme: 'bip86' | 'imported'
}

export interface PearlAddressActivity {
  readonly confirmedTransactionCount: number
  readonly mempoolTransactionCount: number
  readonly used: boolean
  readonly balanceSats: string
}

export function isPearlAddressUsed(activity: PearlAddressActivity): boolean {
  return activity.used
}

export type PearlTransactionStatus =
  | { readonly confirmed: false }
  | {
      readonly confirmed: true
      readonly blockHeight: number
      readonly blockHash?: string
      readonly blockTime?: number
    }

export interface PearlUtxo {
  readonly transactionId: string
  readonly outputIndex: number
  readonly valueSats: string
  readonly address: string
  readonly status: PearlTransactionStatus
}

export interface PearlHistoryTransaction {
  readonly transactionId: string
  readonly status: PearlTransactionStatus
  readonly feeSats?: string
  readonly valueSats?: string
}

export interface PearlDiscoveryTarget {
  readonly change: boolean
}

export const PEARL_DISCOVERY_TARGETS = Object.freeze([
  Object.freeze({ change: false }),
  Object.freeze({ change: true })
] as const satisfies readonly PearlDiscoveryTarget[])

export const PEARL_IMPORTED_PRIVATE_KEY_DISCOVERY_TARGETS = Object.freeze([
  Object.freeze({ change: false })
] as const satisfies readonly PearlDiscoveryTarget[])

export interface PearlDiscoveryCursor {
  readonly target: PearlDiscoveryTarget
  readonly nextAddressIndex: number
  readonly consecutiveUnused: number
  readonly complete: boolean
}

export interface PearlDiscoveryCheckpoint {
  readonly schemaVersion: typeof PEARL_DISCOVERY_CHECKPOINT_SCHEMA_VERSION
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly gapLimit: number
  readonly maximumAddressesPerTarget: number
  readonly cursors: readonly PearlDiscoveryCursor[]
}

export interface PearlAddressObservation {
  readonly derived: DerivedPearlAddress
  readonly activity: PearlAddressActivity
  readonly utxos: readonly PearlUtxo[]
}
