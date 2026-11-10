import { parseChainId } from '@/core/chains/registry'
import { DASH_CHAIN_IDS, PEARL_CHAIN_IDS, QUANTUS_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { parseStoredCaip25Session, type Caip25StoredSession } from './caip25'

/** Reference to a specific account within a specific wallet. */
export interface AccountRef {
  walletId: string
  accountId: string
}

export interface ConnectedDApp {
  id: string
  name: string
  host: string
  origin: string
  favicon: string
  connectedAt: number
  lastActiveAt: number
  boundWalletId?: string
  boundAccountId?: string
  /**
   * Accounts authorized via batch (multi-wallet) connection. When present,
   * this list is authoritative and the single-account binding must refer to one
   * of its entries. Absent for legacy single-account connections.
   */
  authorizedAccounts?: AccountRef[]
  /** Chain-scoped V2 permissions. Legacy Zcash permissions remain above for compatibility. */
  chainAuthorizations?: DAppChainAuthorization[]
  /** CAIP-25 methods and notifications granted by the latest multichain session approval. */
  caip25Session?: Caip25StoredSession
}

export interface DAppChainAuthorization {
  readonly chainId: string
  readonly accounts: AccountRef[]
  readonly binding: AccountRef
}

const STORAGE_KEY = 'connectedDApps'
const AUTHORIZATION_KEY = 'dapp_authorization_state'
const MAX_CONNECTED_DAPPS = 256
const MAX_AUTHORIZED_ACCOUNTS = 100
const MAX_ACCOUNT_REF_LENGTH = 256
const MAX_CONNECTION_TEXT_LENGTH = 2_048

interface AuthorizationState {
  readonly revision: number
  readonly mode: 'approved' | 'revoked'
}

function parseAuthorizationState(value: unknown): Record<string, AuthorizationState> {
  if (value === undefined) return Object.create(null) as Record<string, AuthorizationState>
  if (!isRecord(value)) {
    throw new Error('Invalid stored dApp authorization state')
  }
  const states: Record<string, AuthorizationState> = Object.create(null)
  for (const [origin, state] of Object.entries(value)) {
    parseHttpOrigin(origin)
    if (
      !isRecord(state) ||
      Object.keys(state).some(key => key !== 'revision' && key !== 'mode') ||
      !Number.isSafeInteger(state.revision) ||
      (state.revision as number) < 0 ||
      (state.mode !== 'approved' && state.mode !== 'revoked')
    ) {
      throw new Error('Invalid stored dApp authorization state')
    }
    states[origin] = { revision: state.revision as number, mode: state.mode }
  }
  return states
}

interface DAppConnectionStorage {
  get(key: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isAccountRef(value: unknown): value is AccountRef {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.walletId === 'string' &&
    value.walletId.length > 0 &&
    value.walletId.length <= MAX_ACCOUNT_REF_LENGTH &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    value.accountId.length <= MAX_ACCOUNT_REF_LENGTH
  )
}

function accountRefsEqual(left: AccountRef, right: AccountRef): boolean {
  return left.walletId === right.walletId && left.accountId === right.accountId
}

function normalizeAccountRefs(values: readonly AccountRef[]): AccountRef[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_AUTHORIZED_ACCOUNTS) {
    throw new Error('A dApp connection requires a bounded non-empty Account selection')
  }
  const refs: AccountRef[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!isAccountRef(value)) throw new Error('Invalid dApp Account reference')
    const key = JSON.stringify([value.walletId, value.accountId])
    if (seen.has(key)) throw new Error('Duplicate dApp Account reference')
    seen.add(key)
    refs.push({ walletId: value.walletId, accountId: value.accountId })
  }
  return refs
}

const BITCOIN_DAPP_CHAIN_IDS = new Set([
  'bip122:000000000019d6689c085ae165831e93',
  'bip122:000000000933ea01ad0ee984209779ba'
])
const DASH_DAPP_CHAIN_IDS: ReadonlySet<string> = new Set([
  DASH_CHAIN_IDS.mainnet,
  DASH_CHAIN_IDS.testnet
])
const PEARL_DAPP_CHAIN_IDS: ReadonlySet<string> = new Set([
  PEARL_CHAIN_IDS.mainnet,
  PEARL_CHAIN_IDS.testnet
])
const QUANTUS_DAPP_CHAIN_IDS: ReadonlySet<string> = new Set([
  QUANTUS_CHAIN_IDS.mainnet,
  QUANTUS_CHAIN_IDS.testnet
])
const RELEASED_NATIVE_DAPP_CHAIN_IDS = new Set([
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'near:mainnet',
  'near:testnet'
])
const ZCASH_DAPP_CHAIN_IDS = new Set([
  'bip122:00040fe8ec8471911baa1db1266ea15d',
  'bip122:05a60a92d99d85997cce3b87616c089f'
])

function normalizeDAppChainId(value: string): string {
  const chain = parseChainId(value)
  if (
    chain.namespace !== 'eip155' &&
    !BITCOIN_DAPP_CHAIN_IDS.has(chain.id) &&
    !DASH_DAPP_CHAIN_IDS.has(chain.id) &&
    !PEARL_DAPP_CHAIN_IDS.has(chain.id) &&
    !QUANTUS_DAPP_CHAIN_IDS.has(chain.id) &&
    !ZCASH_DAPP_CHAIN_IDS.has(chain.id) &&
    !RELEASED_NATIVE_DAPP_CHAIN_IDS.has(chain.id)
  ) {
    throw new Error('dApp chain authorization requires a released provider chain')
  }
  return chain.id
}

function normalizeChainAuthorization(value: DAppChainAuthorization): DAppChainAuthorization {
  if (
    !isRecord(value) ||
    Object.keys(value).some(key => !['chainId', 'accounts', 'binding'].includes(key))
  ) {
    throw new Error('Invalid dApp chain authorization')
  }
  const chainId = normalizeDAppChainId(value.chainId)
  const accounts = normalizeAccountRefs(value.accounts)
  if (!isAccountRef(value.binding)) throw new Error('Invalid dApp chain binding')
  if (
    !accounts.some(
      account =>
        account.walletId === value.binding.walletId && account.accountId === value.binding.accountId
    )
  ) {
    throw new Error('The dApp chain binding must be part of its authorized selection')
  }
  return Object.freeze({
    chainId,
    accounts,
    binding: Object.freeze({ ...value.binding })
  })
}

function normalizeChainAuthorizations(
  values: readonly DAppChainAuthorization[] | undefined
): DAppChainAuthorization[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > 16) {
    throw new Error('Invalid dApp chain authorizations')
  }
  const authorizations = values.map(normalizeChainAuthorization)
  if (new Set(authorizations.map(item => item.chainId)).size !== authorizations.length) {
    throw new Error('Duplicate dApp chain authorization')
  }
  return authorizations
}

function retainSessionScopes(
  session: Caip25StoredSession | undefined,
  chainIds: ReadonlySet<string>
): Caip25StoredSession | undefined {
  if (!session) return undefined
  const scopes = session.scopes.filter(scope => chainIds.has(scope.chainId))
  if (scopes.length === 0) return undefined
  return Object.freeze({
    scopes: Object.freeze(scopes),
    ...(session.properties === undefined ? {} : { properties: session.properties })
  })
}

function parseHttpOrigin(value: string): { readonly origin: string; readonly host: string } {
  if (value.length === 0 || value.length > 2048) throw new Error('Invalid dApp origin')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid dApp origin')
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    throw new Error('Invalid dApp origin')
  }
  return { origin: url.origin, host: url.host }
}

function parseStoredText(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean; readonly maximumLength?: number } = {}
): string {
  const maximumLength = options.maximumLength ?? MAX_CONNECTION_TEXT_LENGTH
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > maximumLength
  ) {
    throw new Error(`Invalid stored dApp ${label}`)
  }
  return value
}

function parseStoredTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid stored dApp ${label}`)
  }
  return value as number
}

function requireMonotonicActivityTime(value: unknown, existing?: ConnectedDApp): number {
  const now = parseStoredTime(value, 'authorization time')
  if (existing && now < existing.connectedAt) {
    throw new Error('dApp authorization time predates its connection')
  }
  return existing ? Math.max(now, existing.lastActiveAt) : now
}

function nextActivityTime(connection: ConnectedDApp): number {
  return Math.max(Date.now(), connection.connectedAt, connection.lastActiveAt)
}

export function parseStoredDAppConnection(value: unknown): ConnectedDApp {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      key =>
        ![
          'id',
          'name',
          'host',
          'origin',
          'favicon',
          'connectedAt',
          'lastActiveAt',
          'boundWalletId',
          'boundAccountId',
          'authorizedAccounts',
          'chainAuthorizations',
          'caip25Session'
        ].includes(key)
    )
  ) {
    throw new Error('Invalid stored dApp connection')
  }
  const { origin, host } = parseHttpOrigin(parseStoredText(value.origin, 'origin'))
  if (parseStoredText(value.host, 'host') !== host) {
    throw new Error('Stored dApp host does not match its origin')
  }
  const boundWalletId = value.boundWalletId
  const boundAccountId = value.boundAccountId
  if ((boundWalletId === undefined) !== (boundAccountId === undefined)) {
    throw new Error('Stored dApp binding is incomplete')
  }
  const binding =
    boundWalletId === undefined ? null : { walletId: boundWalletId, accountId: boundAccountId }
  if (binding !== null && !isAccountRef(binding)) {
    throw new Error('Invalid stored dApp binding')
  }
  const authorizedAccounts =
    value.authorizedAccounts === undefined
      ? undefined
      : normalizeAccountRefs(value.authorizedAccounts as AccountRef[])
  if (
    authorizedAccounts !== undefined &&
    binding !== null &&
    !authorizedAccounts.some(account => accountRefsEqual(account, binding))
  ) {
    throw new Error('Stored dApp binding is outside its authorized selection')
  }
  const chainAuthorizations =
    value.chainAuthorizations === undefined
      ? undefined
      : normalizeChainAuthorizations(value.chainAuthorizations as DAppChainAuthorization[])
  const caip25Session =
    value.caip25Session === undefined ? undefined : parseStoredCaip25Session(value.caip25Session)
  const connectedAt = parseStoredTime(value.connectedAt, 'connectedAt')
  const lastActiveAt = parseStoredTime(value.lastActiveAt, 'lastActiveAt')
  if (lastActiveAt < connectedAt) {
    throw new Error('Stored dApp activity predates its connection')
  }

  return {
    id: parseStoredText(value.id, 'id', { maximumLength: 512 }),
    name: parseStoredText(value.name, 'name', { maximumLength: 512 }),
    host,
    origin,
    favicon: parseStoredText(value.favicon, 'favicon', {
      allowEmpty: true,
      maximumLength: 4_096
    }),
    connectedAt,
    lastActiveAt,
    ...(binding === null
      ? {}
      : { boundWalletId: binding.walletId, boundAccountId: binding.accountId }),
    ...(authorizedAccounts === undefined ? {} : { authorizedAccounts }),
    ...(chainAuthorizations === undefined ? {} : { chainAuthorizations }),
    ...(caip25Session === undefined ? {} : { caip25Session })
  }
}

export function parseStoredDAppConnections(value: unknown): ConnectedDApp[] {
  if (!Array.isArray(value) || value.length > MAX_CONNECTED_DAPPS) return []
  const parsed = value.flatMap(candidate => {
    try {
      return [parseStoredDAppConnection(candidate)]
    } catch {
      return []
    }
  })
  const originCounts = new Map<string, number>()
  for (const connection of parsed) {
    originCounts.set(connection.origin, (originCounts.get(connection.origin) ?? 0) + 1)
  }
  return parsed.filter(connection => originCounts.get(connection.origin) === 1)
}

export function connectionHasEvmAuthorization(dapp: ConnectedDApp): boolean {
  try {
    return normalizeChainAuthorizations(dapp.chainAuthorizations).some(
      authorization => parseChainId(authorization.chainId).namespace === 'eip155'
    )
  } catch {
    return false
  }
}

export function connectionHasEvmAuthorizationForAccount(
  dapp: ConnectedDApp,
  account: AccountRef
): boolean {
  if (!isAccountRef(account)) return false
  try {
    return normalizeChainAuthorizations(dapp.chainAuthorizations).some(
      authorization =>
        parseChainId(authorization.chainId).namespace === 'eip155' &&
        authorization.accounts.some(reference => accountRefsEqual(reference, account))
    )
  } catch {
    return false
  }
}

export interface ReplaceDAppAuthorizationInput {
  readonly origin: string
  readonly id: string
  readonly title?: string
  readonly favicon?: string
  readonly accounts: readonly AccountRef[]
  readonly binding: AccountRef
  readonly now: number
}

export function replaceDAppAuthorization(
  existing: ConnectedDApp | undefined,
  input: ReplaceDAppAuthorizationInput
): ConnectedDApp {
  const { origin, host } = parseHttpOrigin(input.origin)
  if (existing && existing.origin !== origin) {
    throw new Error('Cannot replace authorization for another dApp origin')
  }
  const activityTime = requireMonotonicActivityTime(input.now, existing)
  const accounts = normalizeAccountRefs(input.accounts)
  if (!isAccountRef(input.binding)) throw new Error('Invalid dApp Account binding')
  if (
    !accounts.some(
      account =>
        account.walletId === input.binding.walletId && account.accountId === input.binding.accountId
    )
  ) {
    throw new Error('The dApp Account binding must be part of the authorized selection')
  }

  return {
    id: existing?.id ?? input.id,
    name: existing?.name ?? (input.title || host),
    host,
    origin,
    favicon: existing?.favicon ?? input.favicon ?? '',
    connectedAt: existing?.connectedAt ?? activityTime,
    lastActiveAt: activityTime,
    boundWalletId: input.binding.walletId,
    boundAccountId: input.binding.accountId,
    authorizedAccounts: accounts,
    ...(existing?.chainAuthorizations === undefined
      ? {}
      : { chainAuthorizations: normalizeChainAuthorizations(existing.chainAuthorizations) }),
    ...(existing?.caip25Session === undefined ? {} : { caip25Session: existing.caip25Session })
  }
}

/**
 * The explicit authorized set is authoritative. A single-account binding is
 * only a compatibility fallback for connections that predate that set.
 */
export function getConnectionAccountRefs(dapp: ConnectedDApp): AccountRef[] {
  if (dapp.authorizedAccounts !== undefined) {
    try {
      return normalizeAccountRefs(dapp.authorizedAccounts)
    } catch {
      return []
    }
  }
  const legacyBinding = {
    walletId: dapp.boundWalletId,
    accountId: dapp.boundAccountId
  }
  return isAccountRef(legacyBinding) ? [legacyBinding] : []
}

export function connectionAuthorizesAccount(dapp: ConnectedDApp, account: AccountRef): boolean {
  return getConnectionAccountRefs(dapp).some(
    ref => ref.walletId === account.walletId && ref.accountId === account.accountId
  )
}

/**
 * Wallet UI status spans the legacy Zcash permission and every chain-scoped
 * permission. Sensitive RPC handlers must continue using their own scope.
 */
export function connectionAuthorizesAccountForWalletStatus(
  dapp: ConnectedDApp,
  account: AccountRef
): boolean {
  if (connectionAuthorizesAccount(dapp, account)) return true
  try {
    return normalizeChainAuthorizations(dapp.chainAuthorizations).some(authorization =>
      authorization.accounts.some(ref => accountRefsEqual(ref, account))
    )
  } catch {
    return false
  }
}

export interface DAppPrivateExecutionSupportSummary {
  readonly connected: number
  readonly privateCapable: number
  readonly mainOnly: number
}

/**
 * Counts connected origins for the active Account without widening any
 * chain-specific permission. V1 Private Execution is available only to an
 * origin that has an EVM authorization for that Account.
 */
export function summarizeDAppPrivateExecutionSupport(
  dapps: readonly ConnectedDApp[],
  account: AccountRef
): DAppPrivateExecutionSupportSummary {
  const active = dapps.filter(dapp => connectionAuthorizesAccountForWalletStatus(dapp, account))
  const privateCapable = active.filter(dapp =>
    connectionHasEvmAuthorizationForAccount(dapp, account)
  ).length
  return Object.freeze({
    connected: active.length,
    privateCapable,
    mainOnly: active.length - privateCapable
  })
}

export function getConnectionChainAuthorization(
  dapp: ConnectedDApp,
  chainIdValue: string
): DAppChainAuthorization | null {
  const chainId = normalizeDAppChainId(chainIdValue)
  const authorizations = normalizeChainAuthorizations(dapp.chainAuthorizations)
  return authorizations.find(item => item.chainId === chainId) ?? null
}

export function replaceDAppChainAuthorization(
  existing: ConnectedDApp | undefined,
  input: {
    readonly origin: string
    readonly id: string
    readonly title?: string
    readonly favicon?: string
    readonly chainId: string
    readonly accounts: readonly AccountRef[]
    readonly binding: AccountRef
    readonly now: number
  }
): ConnectedDApp {
  const { origin, host } = parseHttpOrigin(input.origin)
  if (existing && existing.origin !== origin) {
    throw new Error('Cannot replace authorization for another dApp origin')
  }
  const activityTime = requireMonotonicActivityTime(input.now, existing)
  const authorization = normalizeChainAuthorization({
    chainId: input.chainId,
    accounts: [...input.accounts],
    binding: input.binding
  })
  const remaining = normalizeChainAuthorizations(existing?.chainAuthorizations).filter(
    item => item.chainId !== authorization.chainId
  )
  return {
    ...(existing ?? {
      id: input.id,
      name: input.title || host,
      host,
      origin,
      favicon: input.favicon ?? '',
      connectedAt: activityTime,
      lastActiveAt: activityTime
    }),
    lastActiveAt: activityTime,
    chainAuthorizations: [...remaining, authorization],
    ...(existing?.caip25Session === undefined ? {} : { caip25Session: existing.caip25Session })
  }
}

export function replaceDAppCaip25Session(
  existing: ConnectedDApp | undefined,
  input: {
    readonly origin: string
    readonly id: string
    readonly title?: string
    readonly favicon?: string
    readonly authorizations: readonly DAppChainAuthorization[]
    readonly session: Caip25StoredSession
    readonly zcashAuthorization?: {
      readonly accounts: readonly AccountRef[]
      readonly binding: AccountRef
    }
    readonly now: number
  }
): ConnectedDApp {
  const { origin, host } = parseHttpOrigin(input.origin)
  if (existing && existing.origin !== origin) {
    throw new Error('Cannot replace a CAIP-25 session for another dApp origin')
  }
  const activityTime = requireMonotonicActivityTime(input.now, existing)
  const session = parseStoredCaip25Session(input.session)
  const replacements = normalizeChainAuthorizations(input.authorizations)
  const replacementIds = new Set(replacements.map(item => item.chainId))
  if (session.scopes.some(scope => !replacementIds.has(scope.chainId))) {
    throw new Error('Every CAIP-25 scope requires a chain authorization')
  }
  const remaining = normalizeChainAuthorizations(existing?.chainAuthorizations).filter(
    item => !replacementIds.has(item.chainId)
  )
  const zcashAuthorization = input.zcashAuthorization
  const zcashAccounts =
    zcashAuthorization === undefined ? undefined : normalizeAccountRefs(zcashAuthorization.accounts)
  if (
    zcashAccounts !== undefined &&
    zcashAuthorization !== undefined &&
    !zcashAccounts.some(account => accountRefsEqual(account, zcashAuthorization.binding))
  ) {
    throw new Error('The CAIP-25 Zcash binding must be part of its authorized selection')
  }
  return {
    ...(existing ?? {
      id: input.id,
      name: input.title || host,
      host,
      origin,
      favicon: input.favicon ?? '',
      connectedAt: activityTime,
      lastActiveAt: activityTime
    }),
    lastActiveAt: activityTime,
    chainAuthorizations: [...remaining, ...replacements],
    caip25Session: session,
    ...(zcashAuthorization === undefined
      ? {}
      : {
          authorizedAccounts: zcashAccounts,
          boundWalletId: zcashAuthorization.binding.walletId,
          boundAccountId: zcashAuthorization.binding.accountId
        })
  }
}

export interface PrunedDAppConnections {
  readonly connections: readonly ConnectedDApp[]
  readonly affectedOrigins: readonly string[]
  readonly disconnectedOrigins: readonly string[]
}

export function pruneDAppChainAuthorizations(
  connections: readonly ConnectedDApp[],
  chainIdValues: readonly string[]
): PrunedDAppConnections {
  const chainIds = new Set(chainIdValues.map(normalizeDAppChainId))
  const kept: ConnectedDApp[] = []
  const affectedOrigins: string[] = []
  const disconnectedOrigins: string[] = []

  for (const connection of connections) {
    const authorizations = normalizeChainAuthorizations(connection.chainAuthorizations)
    const remaining = authorizations.filter(authorization => !chainIds.has(authorization.chainId))
    if (remaining.length === authorizations.length) {
      kept.push(connection)
      continue
    }
    affectedOrigins.push(connection.origin)
    if (remaining.length === 0 && getConnectionAccountRefs(connection).length === 0) {
      disconnectedOrigins.push(connection.origin)
      continue
    }
    kept.push({
      ...connection,
      chainAuthorizations: remaining.length === 0 ? undefined : remaining,
      caip25Session: retainSessionScopes(
        connection.caip25Session,
        new Set(remaining.map(item => item.chainId))
      ),
      lastActiveAt: connection.lastActiveAt
    })
  }

  return Object.freeze({
    connections: Object.freeze(kept),
    affectedOrigins: Object.freeze(affectedOrigins),
    disconnectedOrigins: Object.freeze(disconnectedOrigins)
  })
}

export function pruneDAppAccountReferences(
  connections: readonly ConnectedDApp[],
  target: { readonly walletId: string; readonly accountId?: string }
): PrunedDAppConnections {
  const kept: ConnectedDApp[] = []
  const affectedOrigins: string[] = []
  const disconnectedOrigins: string[] = []

  for (const connection of connections) {
    const refs = getConnectionAccountRefs(connection)
    const remaining = refs.filter(
      ref =>
        ref.walletId !== target.walletId ||
        (target.accountId !== undefined && ref.accountId !== target.accountId)
    )
    const chainAuthorizations = normalizeChainAuthorizations(connection.chainAuthorizations)
    const nextChainAuthorizations = chainAuthorizations.flatMap(authorization => {
      const chainAccounts = authorization.accounts.filter(
        ref =>
          ref.walletId !== target.walletId ||
          (target.accountId !== undefined && ref.accountId !== target.accountId)
      )
      if (chainAccounts.length === 0) return []
      const bindingRemoved =
        authorization.binding.walletId === target.walletId &&
        (target.accountId === undefined || authorization.binding.accountId === target.accountId)
      return [
        Object.freeze({
          ...authorization,
          accounts: chainAccounts,
          binding: bindingRemoved ? chainAccounts[0] : authorization.binding
        })
      ]
    })
    const chainChanged =
      nextChainAuthorizations.some((authorization, index) => {
        const previous = chainAuthorizations[index]
        return (
          !previous ||
          previous.accounts.length !== authorization.accounts.length ||
          previous.binding.walletId !== authorization.binding.walletId ||
          previous.binding.accountId !== authorization.binding.accountId
        )
      }) || nextChainAuthorizations.length !== chainAuthorizations.length
    if (remaining.length === refs.length && !chainChanged) {
      kept.push(connection)
      continue
    }

    affectedOrigins.push(connection.origin)
    if (remaining.length === 0 && nextChainAuthorizations.length === 0) {
      disconnectedOrigins.push(connection.origin)
      continue
    }

    if (remaining.length === 0) {
      kept.push({
        ...connection,
        boundWalletId: undefined,
        boundAccountId: undefined,
        authorizedAccounts: undefined,
        chainAuthorizations: nextChainAuthorizations,
        caip25Session: retainSessionScopes(
          connection.caip25Session,
          new Set(nextChainAuthorizations.map(item => item.chainId))
        )
      })
      continue
    }

    const boundRemoved =
      connection.boundWalletId === target.walletId &&
      (target.accountId === undefined || connection.boundAccountId === target.accountId)
    const nextBinding = boundRemoved
      ? remaining[0]
      : {
          walletId: connection.boundWalletId,
          accountId: connection.boundAccountId
        }
    kept.push({
      ...connection,
      boundWalletId: nextBinding.walletId,
      boundAccountId: nextBinding.accountId,
      authorizedAccounts: remaining,
      chainAuthorizations: nextChainAuthorizations,
      caip25Session: retainSessionScopes(
        connection.caip25Session,
        new Set(nextChainAuthorizations.map(item => item.chainId))
      ),
      lastActiveAt: connection.lastActiveAt
    })
  }

  return Object.freeze({
    connections: Object.freeze(kept),
    affectedOrigins: Object.freeze(affectedOrigins),
    disconnectedOrigins: Object.freeze(disconnectedOrigins)
  })
}

export class DAppManager {
  private static instance: DAppManager
  private connectedDApps: Map<string, ConnectedDApp> = new Map()
  private initialized = false
  private initializationPromise: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()
  private authorizationState: Record<string, AuthorizationState> = Object.create(null)

  constructor(private readonly injectedStorage?: DAppConnectionStorage) {}

  static getInstance(): DAppManager {
    if (!DAppManager.instance) {
      DAppManager.instance = new DAppManager()
    }
    return DAppManager.instance
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializationPromise) return this.initializationPromise

    const operation = (async () => {
      const result = await this.getStorage().get([STORAGE_KEY, AUTHORIZATION_KEY])
      const stored = result[STORAGE_KEY]
      const connections = stored === undefined ? [] : parseStoredDAppConnections(stored)

      this.connectedDApps = new Map(connections.map(dapp => [dapp.origin, dapp]))
      this.authorizationState = parseAuthorizationState(result[AUTHORIZATION_KEY])
      this.initialized = true
    })()
    this.initializationPromise = operation
    try {
      await operation
    } catch (error) {
      console.error('Failed to initialize DAppManager:', error)
      throw error
    } finally {
      if (this.initializationPromise === operation) this.initializationPromise = null
    }
  }

  /**
   * Persist the set of batch-authorized accounts for an origin, creating the
   * connection if it does not exist yet. The binding is committed in the same
   * storage write and must belong to the explicit selection.
   */
  async setAuthorizedAccounts(
    origin: string,
    tabInfo: { title?: string; favIconUrl?: string },
    accounts: AccountRef[],
    binding: AccountRef,
    authorization?: { readonly automatic?: boolean; readonly expectedRevision?: number }
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const state = this.authorizationState[origin]
      if (
        (authorization?.automatic && state !== undefined) ||
        (authorization?.expectedRevision !== undefined &&
          authorization.expectedRevision !== (state?.revision ?? 0))
      ) {
        throw new Error('Site authorization changed. Connect again.')
      }
      const existing = this.connectedDApps.get(origin)
      this.assertConnectionCapacity(existing)
      const replacement = replaceDAppAuthorization(existing, {
        origin,
        id: this.generateId(),
        title: tabInfo.title,
        favicon: tabInfo.favIconUrl || this.getDefaultFavicon(origin),
        accounts,
        binding,
        now: Date.now()
      })
      const next = new Map(this.connectedDApps)
      next.set(origin, replacement)
      const states = { ...this.authorizationState }
      if (!authorization?.automatic) {
        states[origin] = { revision: state?.revision ?? 0, mode: 'approved' }
      }
      await this.commitConnections(next, states)
    })
  }

  async getAuthorization(origin: string): Promise<{ revision: number; accounts: AccountRef[] }> {
    await this.waitForStableState()
    const state = this.authorizationState[origin]
    const connection = this.connectedDApps.get(origin)
    return {
      revision: state?.revision ?? 0,
      accounts: connection && state?.mode !== 'revoked' ? getConnectionAccountRefs(connection) : []
    }
  }

  async getAuthorizationRevision(origin: string): Promise<number> {
    return (await this.getAuthorization(origin)).revision
  }

  async canAutoConnect(origin: string): Promise<boolean> {
    await this.waitForStableState()
    return this.authorizationState[origin] === undefined
  }

  async isRevoked(origin: string): Promise<boolean> {
    await this.waitForStableState()
    return this.authorizationState[origin]?.mode === 'revoked'
  }

  /** Explicit batch authorization, or the valid legacy single-account binding. */
  async getAuthorizedAccounts(origin: string): Promise<AccountRef[]> {
    return (await this.getAuthorization(origin)).accounts
  }

  async setChainAuthorizedAccounts(
    origin: string,
    tabInfo: { title?: string; favIconUrl?: string },
    chainId: string,
    accounts: AccountRef[],
    binding: AccountRef
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const existing = this.connectedDApps.get(origin)
      this.assertConnectionCapacity(existing)
      const replacement = replaceDAppChainAuthorization(existing, {
        origin,
        id: this.generateId(),
        title: tabInfo.title,
        favicon: tabInfo.favIconUrl || this.getDefaultFavicon(origin),
        chainId,
        accounts,
        binding,
        now: Date.now()
      })
      const next = new Map(this.connectedDApps)
      next.set(origin, replacement)
      const states = { ...this.authorizationState }
      if (ZCASH_DAPP_CHAIN_IDS.has(normalizeDAppChainId(chainId))) {
        states[origin] = { revision: states[origin]?.revision ?? 0, mode: 'approved' }
      }
      await this.commitConnections(next, states)
    })
  }

  async getChainAuthorization(
    origin: string,
    chainId: string
  ): Promise<DAppChainAuthorization | null> {
    await this.waitForStableState()
    const dapp = this.connectedDApps.get(origin)
    return dapp ? getConnectionChainAuthorization(dapp, chainId) : null
  }

  async addEvmAuthorizedAccount(
    origin: string,
    chainIdValue: string,
    account: AccountRef
  ): Promise<void> {
    if (parseChainId(chainIdValue).namespace !== 'eip155') {
      throw new Error('Wallet-side account connection requires an EVM network')
    }
    return this.enqueueMutation(async () => {
      await this.initialize()
      const existing = this.connectedDApps.get(origin)
      const authorization = existing && getConnectionChainAuthorization(existing, chainIdValue)
      if (!existing || !authorization || existing.caip25Session) {
        throw new Error('Reconnect from the site to update this network permission')
      }
      const accounts = authorization.accounts.some(ref => accountRefsEqual(ref, account))
        ? authorization.accounts
        : [...authorization.accounts, account]
      const next = new Map(this.connectedDApps)
      next.set(
        origin,
        replaceDAppChainAuthorization(existing, {
          origin,
          id: existing.id,
          chainId: authorization.chainId,
          accounts,
          binding: account,
          now: Date.now()
        })
      )
      await this.commitConnections(next)
    })
  }

  async carryEvmAuthorizationToChain(
    origin: string,
    sourceChainId: string,
    targetChainId: string
  ): Promise<void> {
    if (
      parseChainId(sourceChainId).namespace !== 'eip155' ||
      parseChainId(targetChainId).namespace !== 'eip155'
    ) {
      throw new Error('EVM authorization can only be carried between EVM chains')
    }
    return this.enqueueMutation(async () => {
      await this.initialize()
      const existing = this.connectedDApps.get(origin)
      if (!existing || getConnectionChainAuthorization(existing, targetChainId)) return
      const source = getConnectionChainAuthorization(existing, sourceChainId)
      if (!source) return
      const next = new Map(this.connectedDApps)
      next.set(
        origin,
        replaceDAppChainAuthorization(existing, {
          origin,
          id: existing.id,
          chainId: targetChainId,
          accounts: source.accounts,
          binding: source.binding,
          now: Date.now()
        })
      )
      await this.commitConnections(next)
    })
  }

  async setCaip25Session(
    origin: string,
    tabInfo: { title?: string; favIconUrl?: string },
    authorizations: readonly DAppChainAuthorization[],
    session: Caip25StoredSession,
    zcashAuthorization?: {
      readonly accounts: readonly AccountRef[]
      readonly binding: AccountRef
    }
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const existing = this.connectedDApps.get(origin)
      this.assertConnectionCapacity(existing)
      const replacement = replaceDAppCaip25Session(existing, {
        origin,
        id: this.generateId(),
        title: tabInfo.title,
        favicon: tabInfo.favIconUrl || this.getDefaultFavicon(origin),
        authorizations,
        session,
        ...(zcashAuthorization === undefined ? {} : { zcashAuthorization }),
        now: Date.now()
      })
      const next = new Map(this.connectedDApps)
      next.set(origin, replacement)
      const states = { ...this.authorizationState }
      if (zcashAuthorization !== undefined) {
        states[origin] = { revision: states[origin]?.revision ?? 0, mode: 'approved' }
      }
      await this.commitConnections(next, states)
    })
  }

  async getCaip25Session(origin: string): Promise<Caip25StoredSession | null> {
    await this.waitForStableState()
    return this.connectedDApps.get(origin)?.caip25Session ?? null
  }

  async removeChainAuthorization(origin: string, chainIdValue: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const dapp = this.connectedDApps.get(origin)
      if (!dapp) return
      const chainId = normalizeDAppChainId(chainIdValue)
      const remaining = normalizeChainAuthorizations(dapp.chainAuthorizations).filter(
        item => item.chainId !== chainId
      )
      const next = new Map(this.connectedDApps)
      if (remaining.length === 0 && getConnectionAccountRefs(dapp).length === 0) {
        next.delete(origin)
      } else {
        next.set(origin, {
          ...dapp,
          chainAuthorizations: remaining.length === 0 ? undefined : remaining,
          caip25Session: retainSessionScopes(
            dapp.caip25Session,
            new Set(remaining.map(item => item.chainId))
          ),
          lastActiveAt: nextActivityTime(dapp)
        })
      }
      await this.commitConnections(next)
    })
  }

  /**
   * Add one account to an existing connection's authorized set (wallet-side
   * "Connect" prompt). No-op when the connection is missing or the account is
   * already authorized.
   */
  async addAuthorizedAccount(origin: string, account: AccountRef): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const dapp = this.connectedDApps.get(origin)
      if (!dapp) return

      const refs = getConnectionAccountRefs(dapp)
      if (!refs.some(a => a.walletId === account.walletId && a.accountId === account.accountId)) {
        refs.push(account)
      }
      const next = new Map(this.connectedDApps)
      next.set(origin, {
        ...dapp,
        authorizedAccounts: refs,
        lastActiveAt: nextActivityTime(dapp)
      })
      await this.commitConnections(next)
    })
  }

  async updateConnectionBinding(
    origin: string,
    binding: { walletId: string; accountId: string }
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const dapp = this.connectedDApps.get(origin)
      if (!dapp) return
      if (!connectionAuthorizesAccount(dapp, binding)) {
        throw new Error('Cannot bind a dApp connection to an unauthorized Account')
      }
      const next = new Map(this.connectedDApps)
      next.set(origin, {
        ...dapp,
        boundWalletId: binding.walletId,
        boundAccountId: binding.accountId,
        lastActiveAt: nextActivityTime(dapp)
      })
      await this.commitConnections(next)
    })
  }

  async removeConnection(origin: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const next = new Map(this.connectedDApps)
      next.delete(origin)
      await this.commitConnections(next, this.revokeOrigins([origin]))
    })
  }

  async removeLegacyAuthorization(origin: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const dapp = this.connectedDApps.get(origin)
      if (!dapp || getConnectionAccountRefs(dapp).length === 0) {
        await this.commitConnections(new Map(this.connectedDApps), this.revokeOrigins([origin]))
        return
      }
      const chainAuthorizations = normalizeChainAuthorizations(dapp.chainAuthorizations)
      const next = new Map(this.connectedDApps)
      if (chainAuthorizations.length === 0) {
        next.delete(origin)
      } else {
        next.set(origin, {
          id: dapp.id,
          name: dapp.name,
          host: dapp.host,
          origin: dapp.origin,
          favicon: dapp.favicon,
          connectedAt: dapp.connectedAt,
          lastActiveAt: nextActivityTime(dapp),
          chainAuthorizations,
          caip25Session: dapp.caip25Session
        })
      }
      await this.commitConnections(next, this.revokeOrigins([origin]))
    })
  }

  async removeAccountReferences(
    walletId: string,
    accountId?: string
  ): Promise<PrunedDAppConnections> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const result = pruneDAppAccountReferences(Array.from(this.connectedDApps.values()), {
        walletId,
        ...(accountId === undefined ? {} : { accountId })
      })
      await this.commitConnections(
        new Map(result.connections.map(connection => [connection.origin, connection]))
      )
      return result
    })
  }

  async removeChainAuthorizations(chainIds: readonly string[]): Promise<PrunedDAppConnections> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      if (chainIds.length === 0) {
        return Object.freeze({
          connections: Object.freeze(Array.from(this.connectedDApps.values())),
          affectedOrigins: Object.freeze([]),
          disconnectedOrigins: Object.freeze([])
        })
      }
      const result = pruneDAppChainAuthorizations(
        Array.from(this.connectedDApps.values()),
        chainIds
      )
      await this.commitConnections(
        new Map(result.connections.map(connection => [connection.origin, connection]))
      )
      return result
    })
  }

  async clearConnections(): Promise<readonly string[]> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const origins = Object.freeze(Array.from(this.connectedDApps.keys()))
      await this.commitConnections(new Map(), this.revokeOrigins(origins))
      return origins
    })
  }

  async updateLastActive(origin: string): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.initialize()
      const dapp = this.connectedDApps.get(origin)
      if (!dapp) return
      const next = new Map(this.connectedDApps)
      next.set(origin, { ...dapp, lastActiveAt: nextActivityTime(dapp) })
      await this.commitConnections(next)
    })
  }

  async getConnection(origin: string): Promise<ConnectedDApp | null> {
    await this.waitForStableState()
    return this.connectedDApps.get(origin) || null
  }

  async getAllConnections(): Promise<ConnectedDApp[]> {
    await this.waitForStableState()
    return Array.from(this.connectedDApps.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  async isConnected(origin: string): Promise<boolean> {
    await this.waitForStableState()
    return this.connectedDApps.has(origin)
  }

  async getCurrentTabDApp(): Promise<ConnectedDApp | null> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const currentTab = tabs[0]

      if (!currentTab?.url) return null

      const url = new URL(currentTab.url)
      const origin = url.origin

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null
      }

      return await this.getConnection(origin)
    } catch (error) {
      console.error('Failed to get current tab dApp:', error)
      return null
    }
  }

  private getStorage(): DAppConnectionStorage {
    return this.injectedStorage ?? chrome.storage.local
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const execute = async () => {
        await this.reloadStorage()
        return operation()
      }
      return typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request('noir-dapp-authorization', execute)
        : execute()
    }
    const result = this.mutationQueue.then(run)
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async waitForStableState(): Promise<void> {
    await this.mutationQueue
    const read = () => this.reloadStorage()
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('noir-dapp-authorization', read)
    } else {
      await read()
    }
  }

  private async reloadStorage(): Promise<void> {
    const result = await this.getStorage().get([STORAGE_KEY, AUTHORIZATION_KEY])
    this.connectedDApps = new Map(
      (result[STORAGE_KEY] === undefined
        ? []
        : parseStoredDAppConnections(result[STORAGE_KEY])
      ).map(connection => [connection.origin, connection])
    )
    this.authorizationState = parseAuthorizationState(result[AUTHORIZATION_KEY])
    this.initialized = true
  }

  private revokeOrigins(origins: readonly string[]): Record<string, AuthorizationState> {
    const states = { ...this.authorizationState }
    for (const origin of origins) {
      const revision = states[origin]?.revision ?? 0
      if (revision >= Number.MAX_SAFE_INTEGER)
        throw new Error('Site authorization revision exhausted')
      states[origin] = { revision: revision + 1, mode: 'revoked' }
    }
    return states
  }

  private async commitConnections(
    next: Map<string, ConnectedDApp>,
    states: Record<string, AuthorizationState> = this.authorizationState
  ): Promise<void> {
    await this.getStorage().set({
      [STORAGE_KEY]: Array.from(next.values()),
      [AUTHORIZATION_KEY]: states
    })
    this.connectedDApps = next
    this.authorizationState = states
  }

  private assertConnectionCapacity(existing: ConnectedDApp | undefined): void {
    if (!existing && this.connectedDApps.size >= MAX_CONNECTED_DAPPS) {
      throw new Error('Connected dApp limit reached')
    }
  }

  private generateId(): string {
    return `dapp_${crypto.randomUUID()}`
  }

  private getDefaultFavicon(origin: string): string {
    try {
      const url = new URL(origin)
      return `${url.origin}/favicon.ico`
    } catch {
      return ''
    }
  }
}

export const dappManager = DAppManager.getInstance()
