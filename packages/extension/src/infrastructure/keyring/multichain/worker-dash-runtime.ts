import { KeyringError } from '@/core/keyring/ports'
import type { ChainId } from '@/core/chains/domain'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import {
  MAX_BIP32_INDEX,
  assertExactKeys,
  readArray,
  readBoolean,
  readSafeInteger,
  readString,
  type RawWalletEngine,
  type UnknownRecord
} from './raw-wallet-engine'
import {
  assertImportedDashCoordinate,
  assertRawDashAccountMatches,
  isDashChainId,
  parseDashExportedPrivateKey,
  parseRawDashAccount,
  type DashNetworkName,
  type RawDashAccount
} from './dash-codecs'

export type DashAccountDerivation =
  | {
      readonly family: 'dash'
      readonly batch: false
      readonly chainId: string
      readonly accountIndex: number
      readonly change: boolean
      readonly addressIndex: number
    }
  | {
      readonly family: 'dash'
      readonly batch: true
      readonly chainId: string
      readonly accountIndex: number
      readonly change: boolean
      readonly startAddressIndex: number
      readonly count: number
    }

export interface DashPsbtPreparePayload {
  readonly kind: 'dash-psbt'
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly psbt: string
}

export interface DashMessagePreparePayload {
  readonly kind: 'dash-message'
  readonly chainId: ChainId
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly message: Uint8Array
}

export type DashSigningPreparePayload = DashPsbtPreparePayload | DashMessagePreparePayload

const DASH_BATCH_LIMIT = 1_000

function readDashChainId(value: unknown): string {
  const chainId = readString(value, 'chainId', 64)
  if (!isDashChainId(chainId)) throw new KeyringError('UNSUPPORTED_CHAIN')
  return chainId
}

export function parseDashAccountDerivation(record: UnknownRecord): DashAccountDerivation {
  const batch = !Object.prototype.hasOwnProperty.call(record, 'addressIndex')
  assertExactKeys(
    record,
    batch
      ? ['family', 'chainId', 'accountIndex', 'change', 'startAddressIndex', 'count']
      : ['family', 'chainId', 'accountIndex', 'change', 'addressIndex'],
    [],
    'derive payload'
  )
  const common = {
    family: 'dash' as const,
    chainId: readDashChainId(record.chainId),
    accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
    change: readBoolean(record.change, 'change')
  }
  if (!batch) {
    return Object.freeze({
      ...common,
      batch: false as const,
      addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX)
    })
  }
  const startAddressIndex = readSafeInteger(
    record.startAddressIndex,
    'startAddressIndex',
    MAX_BIP32_INDEX
  )
  const count = readSafeInteger(record.count, 'count', DASH_BATCH_LIMIT)
  if (count === 0 || startAddressIndex > MAX_BIP32_INDEX - (count - 1)) {
    throw new Error('Invalid Dash derivation batch')
  }
  return Object.freeze({ ...common, batch: true as const, startAddressIndex, count })
}

export function assertDashDerivationSession(
  kind: 'mnemonic' | 'private_key',
  derivation: DashAccountDerivation
): void {
  if (kind !== 'private_key') return
  if (derivation.batch) {
    assertImportedDashCoordinate(
      derivation.accountIndex,
      derivation.change,
      derivation.startAddressIndex,
      derivation.count
    )
    return
  }
  assertImportedDashCoordinate(derivation.accountIndex, derivation.change, derivation.addressIndex)
}

export function deriveDashAccountsRaw(
  engine: RawWalletEngine,
  sessionId: number,
  derivation: DashAccountDerivation
): unknown {
  if (derivation.batch) {
    return engine.deriveDashAccounts(
      sessionId,
      derivation.chainId,
      derivation.accountIndex,
      derivation.change,
      derivation.startAddressIndex,
      derivation.count
    )
  }
  return engine.deriveDashAccount(
    sessionId,
    derivation.chainId,
    derivation.accountIndex,
    derivation.change,
    derivation.addressIndex
  )
}

export function parseDerivedDashAccount(
  value: unknown,
  derivation: Extract<DashAccountDerivation, { batch: false }>,
  imported: boolean
): RawDashAccount {
  const account = parseRawDashAccount(value)
  assertRawDashAccountMatches(
    account,
    derivation.chainId,
    derivation.accountIndex,
    derivation.change,
    derivation.addressIndex,
    imported
  )
  return account
}

export function parseDerivedDashAccountBatch(
  value: unknown,
  derivation: Extract<DashAccountDerivation, { batch: true }>,
  imported: boolean
): readonly RawDashAccount[] {
  const accounts = readArray(
    value,
    'DerivedDashAccounts',
    (candidate, offset) => {
      const account = parseRawDashAccount(candidate)
      assertRawDashAccountMatches(
        account,
        derivation.chainId,
        derivation.accountIndex,
        derivation.change,
        derivation.startAddressIndex + offset,
        imported
      )
      return account
    },
    DASH_BATCH_LIMIT
  )
  if (accounts.length !== derivation.count)
    throw new Error('Derived Dash account batch length mismatch')
  return accounts
}

export function assertDashSigningSession(
  kind: 'mnemonic' | 'private_key',
  payload: DashSigningPreparePayload
): void {
  if (kind !== 'private_key') return
  if (payload.kind === 'dash-psbt') {
    assertImportedDashCoordinate(payload.accountIndex, false, 0)
    return
  }
  assertImportedDashCoordinate(payload.accountIndex, payload.change, payload.addressIndex)
}

export function prepareDashSigningRaw(
  engine: RawWalletEngine,
  sessionId: number,
  payload: DashSigningPreparePayload
): unknown {
  if (payload.kind === 'dash-psbt') {
    return engine.prepareDashPsbt(sessionId, payload.chainId, payload.accountIndex, payload.psbt)
  }
  return engine.prepareDashMessage(
    sessionId,
    payload.chainId,
    payload.accountIndex,
    payload.change,
    payload.addressIndex,
    payload.message
  )
}

export function confirmDashSigningRaw(
  engine: RawWalletEngine,
  sessionId: number,
  requestId: number,
  kind: DashSigningPreparePayload['kind']
): unknown {
  return kind === 'dash-psbt'
    ? engine.confirmDashPsbt(sessionId, requestId)
    : engine.confirmDashMessage(sessionId, requestId)
}

export function verifyDashMessageRaw(
  engine: RawWalletEngine,
  chainId: string,
  address: string,
  message: Uint8Array,
  signature: string
): boolean {
  if (!isDashChainId(chainId)) throw new KeyringError('UNSUPPORTED_CHAIN')
  return engine.verifyDashMessage(chainId, address, message, signature)
}

export function dashChainIdForNetwork(network: DashNetworkName): string {
  return network === 'mainnet' ? DASH_CHAIN_IDS.mainnet : DASH_CHAIN_IDS.testnet
}

export function dashExportRequest(chainId: string, accountIndex: number) {
  return Object.freeze({
    chainId,
    accountIndex,
    change: false,
    addressIndex: 0
  })
}

export { parseDashExportedPrivateKey }
