import bs58check from 'bs58check'
import { parseAccountIndex, type AccountIndex, type ChainAccount } from '@/core/accounts/domain'
import type { AddressPrivacy } from '@/core/accounts/domain'
import { getDashNetworkConfig } from '@/config/networks'
import { DASH_CHAIN_IDS, isDashChainId } from '@/core/chains/registry/chain-ids'
import { parseStorageV2ChainAccount } from '@/infrastructure/persistence/schema'
import { DASH_GAP_LIMIT, DASH_MAX_ADDRESSES_PER_CHAIN, DASH_MAX_MONEY_DUFFS } from './config'

export const DASH_DISCOVERY_SCHEMA_VERSION = 1 as const
export const DASH_DISCOVERY_DATABASE = Object.freeze({
  name: 'noir-wallet-dash-discovery-v1-db',
  version: 1
})

export interface DashDiscoveryScope {
  readonly chainAccount: ChainAccount
  readonly accountIndex: AccountIndex
  readonly network: 'mainnet' | 'testnet'
  readonly imported: boolean
}

export interface DashDiscoveryCursor {
  readonly change: boolean
  readonly nextAddressIndex: number
  readonly consecutiveUnused: number
  readonly complete: boolean
  readonly nextPage: number
}

export interface DashDiscoveryCheckpoint {
  readonly schemaVersion: typeof DASH_DISCOVERY_SCHEMA_VERSION
  readonly chainId: string
  readonly network: 'mainnet' | 'testnet'
  readonly accountIndex: number
  readonly imported: boolean
  readonly gapLimit: number
  readonly cursors: readonly DashDiscoveryCursor[]
}

export interface DashDerivedAddress {
  readonly chainId: string
  readonly network: 'mainnet' | 'testnet'
  readonly accountIndex: number
  readonly change: boolean
  readonly addressIndex: number
  readonly address: string
  readonly scheme: 'dash_p2pkh'
  readonly purpose: 'receive' | 'change'
  readonly privacy: AddressPrivacy
  readonly derivationScheme: 'bip44' | 'imported'
  readonly derivationPath: string
  readonly publicKey: string
  readonly scriptPubKey: string
}

export interface DashObservedTransaction {
  readonly transactionId: string
  readonly type: number
  readonly isCoinbase: boolean
  readonly confirmations: number
}

export interface DashUtxoReference {
  readonly transactionId: string
  readonly outputIndex: number
  readonly valueDuffs: string
  readonly confirmations: number
  readonly height?: number
}

export interface DashSpendableUtxo extends DashUtxoReference {
  readonly kind: 'spendable'
  readonly scriptHex: string
}

export interface DashHeldUtxo extends DashUtxoReference {
  readonly kind: 'held'
  readonly reason: 'unconfirmed' | 'coinbase-immature' | 'dip2-special-transaction'
}

export type DashClassifiedUtxo = DashSpendableUtxo | DashHeldUtxo

export interface DashDiscoveryObservation {
  readonly derived: DashDerivedAddress
  readonly pagesFetched: number
  readonly pagesTotal: number
  readonly historyComplete: boolean
  readonly transactions: readonly DashObservedTransaction[]
  readonly utxos: readonly DashClassifiedUtxo[]
}

export interface DashDiscoveryState extends DashDiscoveryScope {
  readonly checkpoint: DashDiscoveryCheckpoint
  readonly observations: readonly DashDiscoveryObservation[]
  readonly updatedAt: number
}

export interface DashDiscoveryProgress extends DashDiscoveryScope {
  readonly checkpoint: DashDiscoveryCheckpoint
  readonly observation: DashDiscoveryObservation
  readonly updatedAt: number
}

export interface DashDiscoveryRefresh extends DashDiscoveryScope {
  readonly checkpoint: DashDiscoveryCheckpoint
  readonly observations: readonly DashDiscoveryObservation[]
  readonly updatedAt: number
}

export interface DashDiscoveryRepository {
  get(
    scope: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
  ): Promise<DashDiscoveryState | null>
  putProgress(progress: DashDiscoveryProgress): Promise<void>
  putRefresh(refresh: DashDiscoveryRefresh): Promise<void>
  deleteByAccountScope(scope: {
    readonly chainId: string
    readonly keyDomainId: string
    readonly accountId: string
  }): Promise<number>
}

const TXID = /^[0-9a-f]{64}$/
const DUFFS = /^(0|[1-9][0-9]*)$/
const PUBLIC_KEY = /^0x0[23][0-9a-f]{64}$/
const SCRIPT = /^0x76a914[0-9a-f]{40}88ac$/
const MAX_PAGE = 1_000_000
const MAX_CONFIRMATIONS = 2_147_483_647

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

export function parseDashDuffAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !DUFFS.test(value)) {
    throw new Error('Invalid Dash duff amount')
  }
  const amount = BigInt(value)
  if (amount > DASH_MAX_MONEY_DUFFS) throw new Error('Invalid Dash duff amount')
  return amount
}

export function parseDashTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid Dash discovery timestamp')
  }
  return value as number
}

export function dashNetworkForChainId(chainId: string): 'mainnet' | 'testnet' {
  if (!isDashChainId(chainId)) throw new Error('Invalid Dash chain ID')
  return chainId === DASH_CHAIN_IDS.mainnet ? 'mainnet' : 'testnet'
}

export function dashAccountPath(chainId: string, accountIndex: number, imported: boolean): string {
  if (imported) return 'm'
  const coinType = getDashNetworkConfig(dashNetworkForChainId(chainId)).coinType
  return `m/44'/${coinType}'/${accountIndex}'`
}

export function dashAddressPath(
  chainId: string,
  accountIndex: number,
  change: boolean,
  addressIndex: number,
  imported: boolean
): string {
  if (imported) {
    if (accountIndex !== 0 || change || addressIndex !== 0) {
      throw new Error('Imported Dash keys cannot be scanned as an HD chain')
    }
    return 'm'
  }
  return `${dashAccountPath(chainId, accountIndex, false)}/${change ? 1 : 0}/${addressIndex}`
}

export function parseDashP2pkhAddress(value: string, chainId: string): string {
  const network = getDashNetworkConfig(dashNetworkForChainId(chainId))
  if (typeof value !== 'string' || value.length < 26 || value.length > 40) {
    throw new Error('Invalid Dash P2PKH address')
  }
  let decoded: Uint8Array
  try {
    decoded = bs58check.decode(value)
  } catch {
    throw new Error('Invalid Dash P2PKH address')
  }
  if (
    decoded.length !== 21 ||
    decoded[0] !== network.p2pkhVersion ||
    bs58check.encode(decoded) !== value
  ) {
    throw new Error('Invalid Dash P2PKH address')
  }
  return value
}

export function dashScopeKey(scope: DashDiscoveryScope): string {
  return JSON.stringify([
    scope.network,
    scope.chainAccount.scope.chainId,
    scope.chainAccount.scope.keyDomainId,
    scope.chainAccount.scope.accountId,
    scope.chainAccount.id
  ])
}

export function dashAccountKey(scope: {
  readonly chainId: string
  readonly keyDomainId: string
  readonly accountId: string
}): string {
  const network = dashNetworkForChainId(scope.chainId)
  return JSON.stringify([network, scope.chainId, scope.keyDomainId, scope.accountId])
}

export function dashObservationKey(change: boolean, addressIndex: number): string {
  return `${change ? 1 : 0}:${addressIndex}`
}

export function parseDashDiscoveryScope(
  value: Pick<DashDiscoveryScope, 'chainAccount' | 'accountIndex'>
): DashDiscoveryScope {
  const chainAccount = parseStorageV2ChainAccount(value.chainAccount)
  const accountIndex = parseAccountIndex(value.accountIndex)
  if (accountIndex > 0x7fffffff) throw new Error('Invalid Dash account index')
  const chainId = chainAccount.scope.chainId
  const network = dashNetworkForChainId(chainId)
  const config = getDashNetworkConfig(network)
  if (chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('Dash discovery requires an account identifier')
  }
  parseDashP2pkhAddress(chainAccount.identity.value, chainId)
  const imported = chainAccount.derivation.scheme === 'imported'
  if (imported) {
    if (chainAccount.derivation.path !== 'm' || accountIndex !== 0) {
      throw new Error('Imported Dash keys cannot be scanned as an HD chain')
    }
  } else if (
    chainAccount.derivation.scheme !== 'bip44' ||
    chainAccount.derivation.path !== dashAddressPath(chainId, accountIndex, false, 0, false) ||
    config.chainId !== chainId
  ) {
    throw new Error('Dash discovery scope does not match the BIP44 P2PKH account')
  }
  return Object.freeze({ chainAccount, accountIndex, network, imported })
}

function parseIndex(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseCursor(value: unknown, gapLimit: number, imported: boolean): DashDiscoveryCursor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'change',
      'nextAddressIndex',
      'consecutiveUnused',
      'complete',
      'nextPage'
    ]) ||
    typeof value.change !== 'boolean' ||
    typeof value.complete !== 'boolean'
  ) {
    throw new Error('Invalid Dash discovery cursor')
  }
  if (imported && value.change) throw new Error('Imported Dash keys cannot scan a change chain')
  const nextAddressIndex = parseIndex(
    value.nextAddressIndex,
    'Dash discovery address index',
    DASH_MAX_ADDRESSES_PER_CHAIN
  )
  const consecutiveUnused = parseIndex(value.consecutiveUnused, 'Dash discovery gap', gapLimit)
  const nextPage = parseIndex(value.nextPage, 'Dash discovery page', MAX_PAGE)
  if (consecutiveUnused > nextAddressIndex) throw new Error('Invalid Dash discovery cursor')
  const complete = imported
    ? nextAddressIndex === 1 && nextPage === 0
    : consecutiveUnused === gapLimit && nextPage === 0
  if (value.complete !== complete) throw new Error('Invalid Dash discovery cursor')
  if (imported && nextAddressIndex > 1) {
    throw new Error('Imported Dash keys cannot be scanned as an HD chain')
  }
  return Object.freeze({
    change: value.change,
    nextAddressIndex,
    consecutiveUnused,
    complete,
    nextPage
  })
}

export function initialDashCheckpoint(scope: DashDiscoveryScope): DashDiscoveryCheckpoint {
  const cursor = (change: boolean): DashDiscoveryCursor =>
    Object.freeze({
      change,
      nextAddressIndex: 0,
      consecutiveUnused: 0,
      complete: false,
      nextPage: 0
    })
  return Object.freeze({
    schemaVersion: DASH_DISCOVERY_SCHEMA_VERSION,
    chainId: scope.chainAccount.scope.chainId,
    network: scope.network,
    accountIndex: scope.accountIndex,
    imported: scope.imported,
    gapLimit: DASH_GAP_LIMIT,
    cursors: Object.freeze(scope.imported ? [cursor(false)] : [cursor(false), cursor(true)])
  })
}

export function parseDashCheckpoint(
  value: unknown,
  scope: DashDiscoveryScope
): DashDiscoveryCheckpoint {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'chainId',
      'network',
      'accountIndex',
      'imported',
      'gapLimit',
      'cursors'
    ]) ||
    value.schemaVersion !== DASH_DISCOVERY_SCHEMA_VERSION ||
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.network !== scope.network ||
    value.accountIndex !== scope.accountIndex ||
    value.imported !== scope.imported ||
    value.gapLimit !== DASH_GAP_LIMIT ||
    !Array.isArray(value.cursors)
  ) {
    throw new Error('Invalid Dash discovery checkpoint')
  }
  const expected = scope.imported ? 1 : 2
  if (value.cursors.length !== expected) throw new Error('Invalid Dash discovery checkpoint')
  const cursors = value.cursors.map(cursor => parseCursor(cursor, DASH_GAP_LIMIT, scope.imported))
  if (cursors[0]?.change !== false || (!scope.imported && cursors[1]?.change !== true)) {
    throw new Error('Invalid Dash discovery checkpoint')
  }
  return Object.freeze({
    schemaVersion: DASH_DISCOVERY_SCHEMA_VERSION,
    chainId: scope.chainAccount.scope.chainId,
    network: scope.network,
    accountIndex: scope.accountIndex,
    imported: scope.imported,
    gapLimit: DASH_GAP_LIMIT,
    cursors: Object.freeze(cursors)
  })
}

function parseDerivedAddress(value: unknown, scope: DashDiscoveryScope): DashDerivedAddress {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'chainId',
      'network',
      'accountIndex',
      'change',
      'addressIndex',
      'address',
      'scheme',
      'purpose',
      'privacy',
      'derivationScheme',
      'derivationPath',
      'publicKey',
      'scriptPubKey'
    ]) ||
    typeof value.change !== 'boolean'
  ) {
    throw new Error('Invalid Dash derived address')
  }
  const addressIndex = parseIndex(
    value.addressIndex,
    'Dash address index',
    DASH_MAX_ADDRESSES_PER_CHAIN - 1
  )
  if (
    value.chainId !== scope.chainAccount.scope.chainId ||
    value.network !== scope.network ||
    value.accountIndex !== scope.accountIndex ||
    value.scheme !== 'dash_p2pkh' ||
    value.privacy !== 'transparent' ||
    value.purpose !== (value.change ? 'change' : 'receive') ||
    (scope.imported && (value.change || addressIndex !== 0))
  ) {
    throw new Error('Invalid Dash derived address')
  }
  const derivationScheme = scope.imported ? 'imported' : 'bip44'
  const derivationPath = dashAddressPath(
    scope.chainAccount.scope.chainId,
    scope.accountIndex,
    value.change,
    addressIndex,
    scope.imported
  )
  if (
    value.derivationScheme !== derivationScheme ||
    value.derivationPath !== derivationPath ||
    typeof value.publicKey !== 'string' ||
    !PUBLIC_KEY.test(value.publicKey) ||
    typeof value.scriptPubKey !== 'string' ||
    !SCRIPT.test(value.scriptPubKey)
  ) {
    throw new Error('Invalid Dash derived address')
  }
  return Object.freeze({
    chainId: scope.chainAccount.scope.chainId,
    network: scope.network,
    accountIndex: scope.accountIndex,
    change: value.change,
    addressIndex,
    address: parseDashP2pkhAddress(String(value.address), scope.chainAccount.scope.chainId),
    scheme: 'dash_p2pkh',
    purpose: value.change ? 'change' : 'receive',
    privacy: 'transparent',
    derivationScheme,
    derivationPath,
    publicKey: value.publicKey,
    scriptPubKey: value.scriptPubKey
  })
}

function parseObservedTransaction(value: unknown): DashObservedTransaction {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['transactionId', 'type', 'isCoinbase', 'confirmations']) ||
    typeof value.transactionId !== 'string' ||
    !TXID.test(value.transactionId) ||
    typeof value.isCoinbase !== 'boolean'
  ) {
    throw new Error('Invalid Dash discovery transaction')
  }
  return Object.freeze({
    transactionId: value.transactionId,
    type: parseIndex(value.type, 'Dash transaction type', 0xffffffff),
    isCoinbase: value.isCoinbase,
    confirmations: parseIndex(value.confirmations, 'Dash confirmations', MAX_CONFIRMATIONS)
  })
}

function parseClassifiedUtxo(value: unknown): DashClassifiedUtxo {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('Invalid Dash UTXO')
  const transactionId = value.transactionId
  if (typeof transactionId !== 'string' || !TXID.test(transactionId)) {
    throw new Error('Invalid Dash UTXO')
  }
  const reference = Object.freeze({
    transactionId,
    outputIndex: parseIndex(value.outputIndex, 'Dash output index', 0xffffffff),
    valueDuffs: parseDashDuffAmount(value.valueDuffs).toString(),
    confirmations: parseIndex(value.confirmations, 'Dash confirmations', MAX_CONFIRMATIONS),
    ...(value.height === undefined
      ? {}
      : { height: parseIndex(value.height, 'Dash block height', MAX_CONFIRMATIONS) })
  })
  if (value.kind === 'spendable') {
    if (
      !hasExactKeys(
        value,
        ['kind', 'transactionId', 'outputIndex', 'valueDuffs', 'confirmations', 'scriptHex'],
        ['height']
      ) ||
      typeof value.scriptHex !== 'string' ||
      !/^[0-9a-f]+$/.test(value.scriptHex) ||
      value.scriptHex.length % 2 !== 0
    ) {
      throw new Error('Invalid Dash spendable UTXO')
    }
    return Object.freeze({ ...reference, kind: 'spendable', scriptHex: value.scriptHex })
  }
  if (
    value.kind !== 'held' ||
    !hasExactKeys(
      value,
      ['kind', 'reason', 'transactionId', 'outputIndex', 'valueDuffs', 'confirmations'],
      ['height']
    ) ||
    (value.reason !== 'unconfirmed' &&
      value.reason !== 'coinbase-immature' &&
      value.reason !== 'dip2-special-transaction') ||
    Object.prototype.hasOwnProperty.call(value, 'scriptHex')
  ) {
    throw new Error('Invalid Dash held UTXO')
  }
  return Object.freeze({ ...reference, kind: 'held', reason: value.reason })
}

export function parseDashObservation(
  value: unknown,
  scope: DashDiscoveryScope
): DashDiscoveryObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'derived',
      'pagesFetched',
      'pagesTotal',
      'historyComplete',
      'transactions',
      'utxos'
    ]) ||
    typeof value.historyComplete !== 'boolean' ||
    !Array.isArray(value.transactions) ||
    !Array.isArray(value.utxos)
  ) {
    throw new Error('Invalid Dash discovery observation')
  }
  const pagesFetched = parseIndex(value.pagesFetched, 'Dash history page', MAX_PAGE)
  const pagesTotal = parseIndex(value.pagesTotal, 'Dash history page count', MAX_PAGE)
  if (value.transactions.length > 100_000 || value.utxos.length > 100_000) {
    throw new Error('Invalid Dash discovery observation')
  }
  const transactions = Object.freeze(value.transactions.map(parseObservedTransaction))
  const seen = new Set<string>()
  const utxos = Object.freeze(
    value.utxos.map(item => {
      const utxo = parseClassifiedUtxo(item)
      const key = `${utxo.transactionId}:${utxo.outputIndex}`
      if (seen.has(key)) throw new Error('Duplicate Dash UTXO')
      seen.add(key)
      return utxo
    })
  )
  if (
    value.historyComplete &&
    (pagesFetched < pagesTotal || (pagesTotal === 0 && pagesFetched !== 1))
  ) {
    throw new Error('Invalid Dash discovery observation')
  }
  return Object.freeze({
    derived: parseDerivedAddress(value.derived, scope),
    pagesFetched,
    pagesTotal,
    historyComplete: value.historyComplete,
    transactions,
    utxos
  })
}

function sameCursor(left: DashDiscoveryCursor, right: DashDiscoveryCursor): boolean {
  return (
    left.change === right.change &&
    left.nextAddressIndex === right.nextAddressIndex &&
    left.consecutiveUnused === right.consecutiveUnused &&
    left.complete === right.complete &&
    left.nextPage === right.nextPage
  )
}

function assertCursorForward(previous: DashDiscoveryCursor, next: DashDiscoveryCursor): void {
  if (next.nextAddressIndex < previous.nextAddressIndex) {
    throw new Error('Dash discovery cursor moved backwards')
  }
  if (next.nextAddressIndex > previous.nextAddressIndex + 1) {
    throw new Error('Dash discovery cursor skipped an address')
  }
  if (next.nextAddressIndex === previous.nextAddressIndex && next.nextPage < previous.nextPage) {
    throw new Error('Dash discovery page moved backwards')
  }
  if (previous.complete && !sameCursor(previous, next)) {
    throw new Error('Completed Dash discovery cursor cannot change during a scan')
  }
}

export function assertDashObservationMatchesCursor(
  checkpoint: DashDiscoveryCheckpoint,
  observation: DashDiscoveryObservation
): void {
  const cursor = checkpoint.cursors.find(item => item.change === observation.derived.change)
  if (!cursor) throw new Error('Dash discovery observation has no cursor')
  if (!observation.historyComplete) {
    if (
      cursor.complete ||
      cursor.nextAddressIndex !== observation.derived.addressIndex ||
      cursor.nextPage !== observation.pagesFetched ||
      cursor.nextPage === 0
    ) {
      throw new Error('Dash discovery page cursor does not match the observation')
    }
    return
  }
  if (cursor.nextPage !== 0 || cursor.nextAddressIndex !== observation.derived.addressIndex + 1) {
    throw new Error('Dash discovery cursor does not match the settled address')
  }
}

function mergeObservation(
  observations: readonly DashDiscoveryObservation[],
  observation: DashDiscoveryObservation
): readonly DashDiscoveryObservation[] {
  const next = observations.filter(
    item =>
      item.derived.change !== observation.derived.change ||
      item.derived.addressIndex !== observation.derived.addressIndex
  )
  next.push(observation)
  next.sort((left, right) => {
    if (left.derived.change !== right.derived.change) return left.derived.change ? 1 : -1
    return left.derived.addressIndex - right.derived.addressIndex
  })
  return Object.freeze(next)
}

function freezeState(
  scope: DashDiscoveryScope,
  checkpoint: DashDiscoveryCheckpoint,
  observations: readonly DashDiscoveryObservation[],
  updatedAt: number
): DashDiscoveryState {
  return Object.freeze({
    chainAccount: scope.chainAccount,
    accountIndex: scope.accountIndex,
    network: scope.network,
    imported: scope.imported,
    checkpoint,
    observations,
    updatedAt
  })
}

export function applyDashDiscoveryProgress(
  existing: DashDiscoveryState | null,
  progress: DashDiscoveryProgress
): DashDiscoveryState {
  const scope = parseDashDiscoveryScope(progress)
  const checkpoint = parseDashCheckpoint(progress.checkpoint, scope)
  const observation = parseDashObservation(progress.observation, scope)
  const updatedAt = parseDashTimestamp(progress.updatedAt)
  assertDashObservationMatchesCursor(checkpoint, observation)
  if (existing) {
    if (dashScopeKey(existing) !== dashScopeKey(scope)) {
      throw new Error('Dash discovery progress belongs to another account')
    }
    if (updatedAt < existing.updatedAt) {
      throw new Error('Dash discovery timestamp cannot move backwards')
    }
    const active = observation.derived.change
    for (const cursor of checkpoint.cursors) {
      const previous = existing.checkpoint.cursors.find(item => item.change === cursor.change)
      if (!previous) throw new Error('Dash discovery cursor disappeared')
      if (cursor.change === active) assertCursorForward(previous, cursor)
      else if (!sameCursor(previous, cursor)) {
        throw new Error('Dash discovery changed an inactive chain')
      }
    }
  }
  return freezeState(
    scope,
    checkpoint,
    mergeObservation(existing?.observations ?? [], observation),
    updatedAt
  )
}

export function applyDashDiscoveryRefresh(
  existing: DashDiscoveryState,
  refresh: DashDiscoveryRefresh
): DashDiscoveryState {
  const scope = parseDashDiscoveryScope(refresh)
  if (dashScopeKey(existing) !== dashScopeKey(scope)) {
    throw new Error('Dash discovery refresh belongs to another account')
  }
  const checkpoint = parseDashCheckpoint(refresh.checkpoint, scope)
  const updatedAt = parseDashTimestamp(refresh.updatedAt)
  if (updatedAt < existing.updatedAt) {
    throw new Error('Dash discovery timestamp cannot move backwards')
  }
  if (
    !Array.isArray(refresh.observations) ||
    refresh.observations.length > DASH_MAX_ADDRESSES_PER_CHAIN * 2
  ) {
    throw new Error('Invalid Dash discovery refresh')
  }
  const observations = Object.freeze(
    refresh.observations.map(observation => parseDashObservation(observation, scope))
  )
  const refreshedKeys = new Set(
    observations.map(observation =>
      dashObservationKey(observation.derived.change, observation.derived.addressIndex)
    )
  )
  for (const observation of existing.observations) {
    const key = dashObservationKey(observation.derived.change, observation.derived.addressIndex)
    if (
      (observation.transactions.length > 0 || observation.utxos.length > 0) &&
      !refreshedKeys.has(key)
    ) {
      throw new Error('Dash discovery refresh dropped a used address')
    }
  }
  for (const cursor of checkpoint.cursors) {
    const previous = existing.checkpoint.cursors.find(item => item.change === cursor.change)
    if (!previous) throw new Error('Dash discovery refresh moved backwards')
    if (cursor.nextAddressIndex < previous.nextAddressIndex) {
      const reopened = previous.complete && !cursor.complete && cursor.nextPage === 0
      if (!reopened) throw new Error('Dash discovery refresh moved backwards')
    }
  }
  return freezeState(scope, checkpoint, observations, updatedAt)
}

export function dashCurrentReceiveAddress(state: DashDiscoveryState): string | null {
  if (state.imported) {
    return (
      state.observations.find(
        observation => !observation.derived.change && observation.derived.addressIndex === 0
      )?.derived.address ?? null
    )
  }
  const cursor = state.checkpoint.cursors.find(item => !item.change)
  if (!cursor) return null
  const index =
    cursor.nextPage > 0
      ? cursor.nextAddressIndex
      : cursor.nextAddressIndex - cursor.consecutiveUnused
  if (!Number.isSafeInteger(index) || index < 0) return null
  return (
    state.observations.find(
      observation => !observation.derived.change && observation.derived.addressIndex === index
    )?.derived.address ?? null
  )
}

export function dashDiscoveryComplete(state: Pick<DashDiscoveryState, 'checkpoint'>): boolean {
  return (
    state.checkpoint.cursors.length > 0 && state.checkpoint.cursors.every(cursor => cursor.complete)
  )
}
