import { ANALYTICS_EVENTS } from '../lib/analytics/constants'
import { emitDAppEvent, observeDAppRequest, type DAppAnalyticsSink } from './dapp-analytics'
import type { EvmNetworkConfig } from '@/config/networks'
import { getBitcoinChainId, getZcashChainId, parseChainId } from '@/core/chains/registry'
import {
  Caip25ProviderError,
  parseCaip25CreateSessionRequest,
  parseCaip25NoParams,
  parseCaip27InvokeMethodRequest,
  parseStoredCaip25Session,
  type Caip25RuntimeMethod,
  type Caip25ScopeRequest,
  type Caip25Session,
  type Caip25StoredScope
} from '@/core/dapp/caip25'
import { BITCOIN_DAPP_RUNTIME_METHODS } from '@/core/dapp/bitcoin-provider'
import { EVM_DAPP_RUNTIME_METHODS } from '@/core/dapp/eip1193'
import {
  NEAR_DAPP_RUNTIME_METHODS,
  SOLANA_DAPP_RUNTIME_METHODS
} from '@/core/dapp/native-transfer-provider'
import type { DAppChainAuthorization, DAppManager } from '@/core/dapp/dapp-manager'
import { shouldAutoConnectDApp } from '@/core/dapp/first-party-policy'
import { DedupPromise } from '@/lib/async-utils'
import type { Network } from '@/types'
import { ZCASH_DAPP_RUNTIME_METHODS } from '@/lib/runtime-message-security'
import type { BackgroundBitcoinDAppHandler } from './bitcoin-dapp-handler'
import type { DAppHandler } from './dapp-handler'
import type {
  DAppSessionAccountProposal,
  DAppSessionAccountSelection
} from './dapp-session-accounts'
import type { BackgroundEvmDAppHandler } from './evm-dapp-handler'
import type { BackgroundNearDAppHandler } from './near-dapp-handler'
import type { BackgroundSolanaDAppHandler } from './solana-dapp-handler'
import type { FirstPartyDAppSessionSnapshot } from './first-party-dapp-session'

export interface MultichainSessionRequest {
  readonly method: Caip25RuntimeMethod
  readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
}

export interface MultichainSessionTabInfo {
  readonly title?: string
  readonly favIconUrl?: string
  readonly pageUrl?: string
}

type ChainFamily = 'zcash' | 'evm' | 'bitcoin' | 'solana' | 'near'

interface SupportedScope {
  readonly family: ChainFamily
  readonly chainId: string
  readonly chainName: string
  readonly iconChain: string
  readonly methods: ReadonlySet<string>
  readonly notifications: ReadonlySet<string>
}

interface PreparedScope {
  readonly supported: SupportedScope
  readonly request: Caip25ScopeRequest
  readonly proposal: DAppSessionAccountProposal
}

function evmApprovalProposal(
  prepared: readonly PreparedScope[]
): DAppSessionAccountProposal | null {
  const evm = prepared.filter(item => item.supported.family === 'evm')
  const first = evm[0]?.proposal
  if (!first) return null
  const accounts = first.accounts.filter(account =>
    evm.every(item =>
      item.proposal.accounts.some(
        candidate =>
          candidate.id === account.id &&
          candidate.reference.walletId === account.reference.walletId &&
          candidate.reference.accountId === account.reference.accountId &&
          candidate.address === account.address
      )
    )
  )
  if (
    !accounts.some(account => account.required) ||
    evm.some(
      item =>
        item.proposal.activeReference.walletId !== first.activeReference.walletId ||
        item.proposal.activeReference.accountId !== first.activeReference.accountId ||
        item.proposal.activeAddress !== first.activeAddress
    )
  ) {
    throw new Caip25ProviderError(5100, 'No common EVM account is available for this session.')
  }
  return Object.freeze({
    ...first,
    chainId: 'evm',
    chainName: 'EVM',
    iconChain: 'evm',
    accounts: Object.freeze(accounts),
    preselectedIds: Object.freeze(
      accounts
        .filter(
          account =>
            account.required || evm.every(item => item.proposal.preselectedIds.includes(account.id))
        )
        .map(account => account.id)
    )
  })
}

type SessionHandler = Pick<
  BackgroundBitcoinDAppHandler,
  'prepareSessionAccountSelection' | 'resolveSessionAccountSelection' | 'getSessionAccounts'
>

export interface BackgroundMultichainSessionDAppHandlerOptions {
  readonly readTokenList?: (scope: {
    readonly keyDomainId: string
    readonly accountId: string
    readonly chainIds: readonly string[]
  }) => Promise<
    readonly Readonly<{
      assetId: string
      chainId: string
      contractAddress: string | null
      symbol: string
      decimals: number
      enabled: boolean
    }>[]
  >
  readonly openTokenManager?: () => Promise<void>
  readonly analytics?: DAppAnalyticsSink
  readonly network: Network
  readonly evmNetworks: readonly EvmNetworkConfig[]
  readonly activeChainIds?: () => Promise<readonly string[]>
  readonly manager: Pick<
    DAppManager,
    | 'getAllConnections'
    | 'getCaip25Session'
    | 'setCaip25Session'
    | 'getAuthorizationRevision'
    | 'canAutoConnectSession'
  >
  readonly readFirstPartySnapshot?: () => Promise<FirstPartyDAppSessionSnapshot | null>
  readonly approval: Pick<
    DAppHandler,
    'requestExternalApproval' | 'broadcastProviderEvent' | 'cancelPendingApprovals'
  >
  readonly zcash: Pick<
    DAppHandler,
    | 'prepareSessionAccountSelection'
    | 'resolveSessionAccountSelection'
    | 'getSessionAccounts'
    | 'revokeAllPermissions'
  >
  readonly evm: Pick<
    BackgroundEvmDAppHandler,
    | 'prepareSessionAccountSelection'
    | 'resolveSessionAccountSelection'
    | 'getSessionAccounts'
    | 'getCaip2ChainId'
  >
  readonly getActiveEvmChainId?: (origin: string) => Promise<string>
  readonly bitcoin: SessionHandler
  readonly bitcoinEnabled?: boolean
  readonly solana: Pick<
    BackgroundSolanaDAppHandler,
    'prepareSessionAccountSelection' | 'resolveSessionAccountSelection' | 'getSessionAccounts'
  > | null
  readonly near: Pick<
    BackgroundNearDAppHandler,
    'prepareSessionAccountSelection' | 'resolveSessionAccountSelection' | 'getSessionAccounts'
  > | null
  readonly solanaScope?: {
    readonly chainId: string
    readonly chainName: string
    readonly iconChain: string
  }
  readonly nearScope?: {
    readonly chainId: string
    readonly chainName: string
    readonly iconChain: string
  }
  readonly dispatch: (
    family: ChainFamily,
    request: {
      readonly method: string
      readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
    },
    origin: string,
    tabInfo: MultichainSessionTabInfo,
    expectedChainId?: string
  ) => Promise<unknown>
}

const SESSION_NOTIFICATIONS = Object.freeze(
  new Set(['wallet_sessionChanged', 'accountsChanged', 'chainChanged', 'networkChanged'])
)

function invocableMethods(
  methods: readonly string[],
  excluded: readonly string[]
): ReadonlySet<string> {
  const excludedSet = new Set(excluded)
  return Object.freeze(new Set(methods.filter(method => !excludedSet.has(method))))
}

const ZCASH_SESSION_METHODS = invocableMethods(ZCASH_DAPP_RUNTIME_METHODS, [
  'zcash_requestAccounts',
  'zcash_disconnect',
  'zcash_switchNetwork'
])
const EVM_SESSION_METHODS = invocableMethods(EVM_DAPP_RUNTIME_METHODS, [
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'wallet_revokePermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain'
])
const BITCOIN_SESSION_METHODS = invocableMethods(BITCOIN_DAPP_RUNTIME_METHODS, [
  'connect',
  'requestAccounts',
  'disconnect',
  'switchNetwork',
  'switchChain'
])
const SOLANA_SESSION_METHODS = invocableMethods(SOLANA_DAPP_RUNTIME_METHODS, [
  'connect',
  'requestAccounts',
  'disconnect'
])
const NEAR_SESSION_METHODS = invocableMethods(NEAR_DAPP_RUNTIME_METHODS, [
  'connect',
  'requestAccounts',
  'disconnect'
])

function formatCaip10Account(chainId: string, address: string): string {
  return `${chainId}:${address}`
}

function requestedAddresses(
  chainId: string,
  request: Caip25ScopeRequest
): ReadonlySet<string> | null {
  if (request.accounts === undefined) return null
  const prefix = `${chainId}:`
  return new Set(request.accounts.map(account => account.slice(prefix.length)))
}

function filterRequestedAccounts(
  proposal: DAppSessionAccountProposal,
  request: Caip25ScopeRequest
): DAppSessionAccountProposal {
  const requested = requestedAddresses(proposal.chainId, request)
  if (requested === null) return proposal
  const accounts = proposal.accounts.filter(account => requested.has(account.address))
  if (accounts.length === 0 || !accounts.some(account => account.required)) {
    throw new Caip25ProviderError(
      5100,
      `The requested ${proposal.chainName} accounts are not available in the active wallet.`
    )
  }
  return Object.freeze({
    ...proposal,
    accounts: Object.freeze(accounts),
    preselectedIds: Object.freeze(
      proposal.preselectedIds.filter(id => accounts.some(account => account.id === id))
    )
  })
}

function assertScopeCapabilities(scope: SupportedScope, request: Caip25ScopeRequest): void {
  const unsupportedMethod = request.methods.find(method => !scope.methods.has(method))
  if (unsupportedMethod) {
    throw new Caip25ProviderError(
      5101,
      `${unsupportedMethod} is not supported for CAIP-25 scope ${scope.chainId}.`
    )
  }
  const unsupportedNotification = request.notifications.find(
    notification => !scope.notifications.has(notification)
  )
  if (unsupportedNotification) {
    throw new Caip25ProviderError(
      5102,
      `${unsupportedNotification} is not supported for CAIP-25 scope ${scope.chainId}.`
    )
  }
}

export function toCaip25ErrorShape(error: unknown): {
  readonly code: number
  readonly message: string
} {
  if (error instanceof Caip25ProviderError) {
    return Object.freeze({ code: error.code, message: error.message })
  }
  if (
    error &&
    typeof error === 'object' &&
    Number.isSafeInteger(Reflect.get(error, 'code')) &&
    typeof Reflect.get(error, 'message') === 'string'
  ) {
    return Object.freeze({
      code: Reflect.get(error, 'code') as number,
      message: Reflect.get(error, 'message') as string
    })
  }
  return Object.freeze({ code: -32603, message: 'Noir Wallet could not complete the request.' })
}

export class BackgroundMultichainSessionDAppHandler {
  private readonly supportedScopes: ReadonlyMap<string, SupportedScope>
  private readonly firstPartyReads = new Map<
    string,
    DedupPromise<Caip25Session | null | undefined>
  >()
  private readonly firstPartyIdentities = new Map<string, string>()

  constructor(private readonly options: BackgroundMultichainSessionDAppHandlerOptions) {
    const scopes: SupportedScope[] = [
      {
        family: 'zcash',
        chainId: getZcashChainId(options.network),
        chainName: options.network === 'mainnet' ? 'Zcash' : 'Zcash Testnet',
        iconChain: 'zec',
        methods: ZCASH_SESSION_METHODS,
        notifications: SESSION_NOTIFICATIONS
      },
      ...options.evmNetworks.map(network => ({
        family: 'evm' as const,
        chainId: network.chainId,
        chainName: network.displayName,
        iconChain: network.iconChain,
        methods: EVM_SESSION_METHODS,
        notifications: SESSION_NOTIFICATIONS
      })),
      ...(options.bitcoinEnabled !== false
        ? [
            {
              family: 'bitcoin' as const,
              chainId: getBitcoinChainId(options.network),
              chainName: options.network === 'mainnet' ? 'Bitcoin' : 'Bitcoin Testnet',
              iconChain: 'btc',
              methods: BITCOIN_SESSION_METHODS,
              notifications: SESSION_NOTIFICATIONS
            }
          ]
        : []),
      ...(options.solana && options.solanaScope
        ? [
            {
              family: 'solana' as const,
              ...options.solanaScope,
              methods: SOLANA_SESSION_METHODS,
              notifications: SESSION_NOTIFICATIONS
            }
          ]
        : []),
      ...(options.near && options.nearScope
        ? [
            {
              family: 'near' as const,
              ...options.nearScope,
              methods: NEAR_SESSION_METHODS,
              notifications: SESSION_NOTIFICATIONS
            }
          ]
        : [])
    ]
    this.supportedScopes = new Map(scopes.map(scope => [scope.chainId, Object.freeze(scope)]))
  }

  async request(
    request: MultichainSessionRequest,
    origin: string,
    tabInfo: MultichainSessionTabInfo
  ): Promise<unknown> {
    switch (request.method) {
      case 'wallet_createSession':
        return observeDAppRequest(this.options.analytics, 'zcash', request.method, () =>
          this.createSession(request.params, origin, tabInfo)
        )
      case 'wallet_getSession':
        parseCaip25NoParams(request.params)
        return this.getSession(origin)
      case 'wallet_getTokenList':
      case 'wallet_openTokenManager':
        parseCaip25NoParams(request.params)
        return this.handleTokenAccess(origin, request.method === 'wallet_openTokenManager')
      case 'wallet_revokeSession':
        parseCaip25NoParams(request.params)
        await this.options.zcash.revokeAllPermissions(origin)
        await this.notifySessionChanged(origin)
        return null
      case 'wallet_invokeMethod':
        return this.invokeMethod(request.params, origin, tabInfo)
    }
  }

  async notifyAllSessionsChanged(): Promise<void> {
    const connections = await this.options.manager.getAllConnections()
    await Promise.all(
      connections
        .filter(connection => connection.caip25Session !== undefined)
        .map(connection => this.notifySessionChanged(connection.origin))
    )
  }

  private async handleTokenAccess(origin: string, openManager: boolean): Promise<unknown> {
    const session = await this.getSession(origin)
    const snapshot = await this.options.readFirstPartySnapshot?.()
    const active = snapshot?.activeReference
    if (!session || !snapshot || !active) {
      throw new Caip25ProviderError(4100, 'Connect and unlock the current wallet account first.')
    }
    const revision = await this.options.manager.getAuthorizationRevision(origin)
    const stored = await this.options.manager.getCaip25Session(origin)
    const chainIds =
      stored?.scopes
        .filter(
          scope =>
            session.scopes[scope.chainId]?.accounts.length > 0 &&
            scope.accounts?.some(
              account =>
                account.walletId === active.walletId && account.accountId === active.accountId
            )
        )
        .map(scope => scope.chainId) ?? []
    if (chainIds.length === 0) {
      throw new Caip25ProviderError(4100, 'The current wallet account is not authorized.')
    }
    const result = openManager
      ? null
      : await this.options.readTokenList?.({
          keyDomainId: active.walletId,
          accountId: active.accountId,
          chainIds
        })
    if (
      (await this.options.readFirstPartySnapshot?.())?.identity !== snapshot.identity ||
      (await this.options.manager.getAuthorizationRevision(origin)) !== revision
    ) {
      throw new Caip25ProviderError(4100, 'Wallet authorization changed. Try again.')
    }
    if (openManager) {
      if (!this.options.openTokenManager)
        throw new Caip25ProviderError(4200, 'Token Manager is unavailable.')
      await this.options.openTokenManager()
      return null
    }
    if (!result) throw new Caip25ProviderError(4200, 'Token list is unavailable.')
    return result
  }

  async notifySessionChanged(origin: string): Promise<void> {
    const session = await this.getSession(origin)
    await this.options.approval
      .broadcastProviderEvent(
        origin,
        'multichain',
        'wallet_sessionChanged',
        session ?? Object.freeze({ scopes: Object.freeze({}) })
      )
      .catch(() => {})
  }

  private getSupportedScope(chainIdValue: string): SupportedScope {
    const chainId = parseChainId(chainIdValue).id
    const scope = this.supportedScopes.get(chainId)
    if (!scope) throw new Caip25ProviderError(5100, `Chain ${chainId} is not supported.`)
    return scope
  }

  private async prepareScope(
    origin: string,
    chainId: string,
    request: Caip25ScopeRequest
  ): Promise<PreparedScope> {
    const supported = this.getSupportedScope(chainId)
    assertScopeCapabilities(supported, request)
    let proposal: DAppSessionAccountProposal
    switch (supported.family) {
      case 'zcash':
        proposal = await this.options.zcash.prepareSessionAccountSelection(origin)
        break
      case 'evm':
        proposal = await this.options.evm.prepareSessionAccountSelection(origin, supported)
        break
      case 'bitcoin':
        if (this.options.bitcoinEnabled === false)
          throw new Caip25ProviderError(5100, 'Bitcoin is unavailable.')
        proposal = await this.options.bitcoin.prepareSessionAccountSelection(origin)
        break
      case 'solana':
        if (!this.options.solana) throw new Caip25ProviderError(5100, 'Solana is unavailable.')
        proposal = await this.options.solana.prepareSessionAccountSelection(origin)
        break
      case 'near':
        if (!this.options.near) throw new Caip25ProviderError(5100, 'NEAR is unavailable.')
        proposal = await this.options.near.prepareSessionAccountSelection(origin)
        break
    }
    return Object.freeze({
      supported,
      request,
      proposal: filterRequestedAccounts({ ...proposal, chainId: supported.chainId }, request)
    })
  }

  private async resolveScopeSelection(
    prepared: PreparedScope,
    selectedIds: readonly string[]
  ): Promise<DAppSessionAccountSelection> {
    switch (prepared.supported.family) {
      case 'zcash':
        return this.options.zcash.resolveSessionAccountSelection(prepared.proposal, selectedIds)
      case 'evm':
        return this.options.evm.resolveSessionAccountSelection(prepared.proposal, selectedIds)
      case 'bitcoin':
        if (this.options.bitcoinEnabled === false)
          throw new Caip25ProviderError(5100, 'Bitcoin is unavailable.')
        return this.options.bitcoin.resolveSessionAccountSelection(prepared.proposal, selectedIds)
      case 'solana':
        if (!this.options.solana) throw new Caip25ProviderError(5100, 'Solana is unavailable.')
        return this.options.solana.resolveSessionAccountSelection(prepared.proposal, selectedIds)
      case 'near':
        if (!this.options.near) throw new Caip25ProviderError(5100, 'NEAR is unavailable.')
        return this.options.near.resolveSessionAccountSelection(prepared.proposal, selectedIds)
    }
  }

  private async createSession(
    params: unknown,
    origin: string,
    tabInfo: MultichainSessionTabInfo
  ): Promise<Caip25Session> {
    const parsed = parseCaip25CreateSessionRequest(params, origin)
    if (shouldAutoConnectDApp(origin)) {
      for (const [chainId, scope] of Object.entries(parsed.scopes)) {
        const supported = this.supportedScopes.get(chainId)
        if (supported) assertScopeCapabilities(supported, scope)
      }
      const automatic = await this.getFirstPartySession(origin, tabInfo, parsed.properties)
      if (automatic !== undefined) {
        if (!automatic)
          throw new Caip25ProviderError(4100, 'Unlock Noir Wallet before connecting this site.')
        await this.notifySessionChanged(origin)
        return automatic
      }
    }
    const activeChains = this.options.activeChainIds
      ? new Set(await this.options.activeChainIds())
      : null
    const requested = Object.entries(parsed.scopes).filter(
      ([chainId]) =>
        this.supportedScopes.has(chainId) && (activeChains === null || activeChains.has(chainId))
    )
    if (requested.length === 0)
      throw new Caip25ProviderError(
        5100,
        'The requested networks are not supported by the active account.'
      )
    for (const [chainId, scope] of requested) {
      assertScopeCapabilities(this.getSupportedScope(chainId), scope)
    }
    const authorizationRevision = await this.options.manager.getAuthorizationRevision(origin)
    const prepared = await Promise.all(
      requested.map(([chainId, scope]) => this.prepareScope(origin, chainId, scope))
    )
    const evmProposal = evmApprovalProposal(prepared)
    const approvalScopes = prepared.flatMap((item, index) => {
      if (item.supported.family !== 'evm') return [item.proposal]
      return prepared.findIndex(scope => scope.supported.family === 'evm') === index && evmProposal
        ? [evmProposal]
        : []
    })
    const accountLabels = new Map(
      prepared
        .filter(item => item.supported.family !== 'zcash')
        .flatMap(item => item.proposal.accounts)
        .map(account => [
          JSON.stringify([account.reference.walletId, account.reference.accountId]),
          account.label
        ])
    )
    const decision = await this.options.approval.requestExternalApproval(
      origin,
      'multichainConnect',
      {
        scopes: approvalScopes.map(proposal => ({
          chainId: proposal.chainId,
          chainName: proposal.chainName,
          iconChain: proposal.iconChain,
          networks: prepared
            .filter(item =>
              proposal.chainId === 'evm'
                ? item.supported.family === 'evm'
                : item.supported.chainId === proposal.chainId
            )
            .map(({ supported }) => ({
              chainId: supported.chainId,
              chainName: supported.chainName,
              iconChain: supported.iconChain
            })),
          accounts: proposal.accounts.map(account => ({
            id: account.id,
            accountKey: JSON.stringify([account.reference.walletId, account.reference.accountId]),
            label:
              accountLabels.get(
                JSON.stringify([account.reference.walletId, account.reference.accountId])
              ) ?? account.label,
            address: account.address,
            required: account.required
          })),
          preselectedIds: proposal.preselectedIds
        })),
        ...(tabInfo.favIconUrl === undefined ? {} : { favicon: tabInfo.favIconUrl }),
        ...(tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: tabInfo.pageUrl })
      }
    )
    if (!decision.approved) {
      throw new Caip25ProviderError(4001, 'User rejected the session request.')
    }
    const selectedScopes = decision.selectedScopes
    if (!selectedScopes) {
      throw new Caip25ProviderError(-32603, 'The wallet approval did not return scope selections.')
    }
    if (
      Object.keys(selectedScopes).some(
        id => !approvalScopes.some(proposal => proposal.chainId === id)
      ) ||
      approvalScopes.some(proposal => {
        const ids = selectedScopes[proposal.chainId]
        return (
          !ids ||
          ids.length === 0 ||
          new Set(ids).size !== ids.length ||
          ids.some(id => !proposal.accounts.some(account => account.id === id))
        )
      })
    ) {
      throw new Caip25ProviderError(4100, 'The selected session accounts are not available.')
    }
    const selections = await Promise.all(
      prepared.map(item =>
        this.resolveScopeSelection(
          item,
          selectedScopes[item.supported.family === 'evm' ? 'evm' : item.supported.chainId]!
        )
      )
    )
    const authorizations: DAppChainAuthorization[] = selections.map(
      selection => selection.authorization
    )
    const zcashIndex = prepared.findIndex(item => item.supported.family === 'zcash')
    const zcashSelection = zcashIndex < 0 ? undefined : selections[zcashIndex]
    const storedScopes: Caip25StoredScope[] = prepared.map((item, index) =>
      Object.freeze({
        chainId: item.supported.chainId,
        methods: item.request.methods,
        notifications: item.request.notifications,
        ...(item.supported.family === 'evm'
          ? { accounts: selections[index]!.authorization.accounts }
          : {})
      })
    )
    await this.options.manager.setCaip25Session(
      origin,
      tabInfo,
      authorizations,
      Object.freeze({
        scopes: Object.freeze(storedScopes),
        ...(parsed.properties === undefined ? {} : { properties: parsed.properties })
      }),
      zcashSelection === undefined
        ? undefined
        : {
            accounts: zcashSelection.authorization.accounts,
            binding: zcashSelection.authorization.binding
          },
      authorizationRevision
    )
    const session = await this.getSession(origin)
    if (!session) throw new Caip25ProviderError(-32603, 'The session could not be persisted.')
    await this.notifySessionChanged(origin)
    for (const item of prepared) {
      const selected = selections[prepared.indexOf(item)]
      emitDAppEvent(
        this.options.analytics,
        item.supported.family,
        ANALYTICS_EVENTS.DAPP_CONNECTED,
        { extra: { account_count: selected.authorization.accounts.length, source: 'session' } }
      )
    }
    return session
  }

  private async getFirstPartySession(
    origin: string,
    tabInfo: MultichainSessionTabInfo = {},
    properties?: Readonly<Record<string, unknown>>
  ): Promise<Caip25Session | null | undefined> {
    const readSnapshot = this.options.readFirstPartySnapshot
    if (!readSnapshot || !shouldAutoConnectDApp(origin)) return undefined
    let read = this.firstPartyReads.get(origin)
    if (!read) {
      read = new DedupPromise()
      this.firstPartyReads.set(origin, read)
    }
    if (properties !== undefined && read.isPending) {
      await read.run(async () => undefined)
      return this.getFirstPartySession(origin, tabInfo, properties)
    }
    return read.run(async () => {
      if (!(await this.options.manager.canAutoConnectSession(origin))) return undefined
      const revision = await this.options.manager.getAuthorizationRevision(origin)
      const snapshot = await readSnapshot()
      if (!snapshot) return null
      const supported = [...this.supportedScopes.values()].filter(
        scope => snapshot.accounts[scope.chainId]?.length
      )
      if (supported.length === 0) return null

      // EVM providers share an account grant; enabled identities remain scoped by the catalog.
      const evmAccounts = new Map(
        supported
          .filter(scope => scope.family === 'evm')
          .flatMap(scope => snapshot.accounts[scope.chainId])
          .map(account => [JSON.stringify(account.reference), account.reference])
      )
      const authorizations: DAppChainAuthorization[] = supported.map(scope => {
        const accounts =
          scope.family === 'evm'
            ? [...evmAccounts.values()]
            : snapshot.accounts[scope.chainId].map(account => account.reference)
        const binding =
          accounts.find(
            account =>
              account.walletId === snapshot.activeReference?.walletId &&
              account.accountId === snapshot.activeReference?.accountId
          ) ?? accounts[0]
        return { chainId: scope.chainId, accounts, binding }
      })
      const stored = await this.options.manager.getCaip25Session(origin)
      const session = parseStoredCaip25Session(
        {
          scopes: supported.map((scope, index) => ({
            chainId: scope.chainId,
            methods: [...scope.methods],
            notifications: [...scope.notifications],
            accounts: authorizations[index].accounts
          })),
          ...((properties ?? stored?.properties) === undefined
            ? {}
            : { properties: properties ?? stored?.properties })
        },
        origin
      )
      if ((await readSnapshot())?.identity !== snapshot.identity) return null
      if (
        this.firstPartyIdentities.get(origin) !== snapshot.identity ||
        JSON.stringify(stored) !== JSON.stringify(session)
      ) {
        const zcash = authorizations.find(
          item => item.chainId === getZcashChainId(this.options.network)
        )
        await this.options.manager.setCaip25Session(
          origin,
          tabInfo,
          authorizations,
          session,
          zcash && { accounts: zcash.accounts, binding: zcash.binding },
          revision,
          { automatic: true }
        )
        this.firstPartyIdentities.set(origin, snapshot.identity)
      }

      const evm = supported.find(scope => scope.family === 'evm')
      const executionAccounts = evm ? await this.getScopeAccounts(origin, evm) : []
      const scopes: Record<string, Caip25Session['scopes'][string]> = Object.create(null)
      for (const scope of supported) {
        const available = snapshot.accounts[scope.chainId]
        let addresses = [...new Set(available.map(account => account.address))]
        const active = available.find(
          account =>
            account.reference.walletId === snapshot.activeReference?.walletId &&
            account.reference.accountId === snapshot.activeReference?.accountId
        )
        // An unavailable private identity must never fall back to Main addresses.
        if (scope.family === 'evm' && snapshot.executionMode === 'private') {
          addresses =
            active &&
            executionAccounts.length === 1 &&
            executionAccounts[0].toLowerCase() !== active.address.toLowerCase()
              ? [...executionAccounts]
              : []
        }
        scopes[scope.chainId] = {
          accounts: addresses.map(address => formatCaip10Account(scope.chainId, address)),
          methods: [...scope.methods],
          notifications: [...scope.notifications]
        }
      }
      if ((await readSnapshot())?.identity !== snapshot.identity) return null
      if (
        !(await this.options.manager.canAutoConnectSession(origin)) ||
        (await this.options.manager.getAuthorizationRevision(origin)) !== revision
      )
        return null
      return {
        scopes,
        ...(session.properties === undefined ? {} : { properties: session.properties })
      }
    })
  }

  private async getSession(origin: string): Promise<Caip25Session | null> {
    const automatic = await this.getFirstPartySession(origin)
    if (automatic !== undefined) return automatic
    const stored = await this.options.manager.getCaip25Session(origin)
    if (!stored) return null
    const scopes: Record<string, Caip25Session['scopes'][string]> = Object.create(null)
    for (const scope of stored.scopes) {
      const supported = this.supportedScopes.get(scope.chainId)
      if (!supported) continue
      const addresses = await this.getScopeAccounts(origin, supported)
      scopes[scope.chainId] = Object.freeze({
        accounts: Object.freeze(
          addresses.map(address => formatCaip10Account(scope.chainId, address))
        ),
        methods: scope.methods,
        notifications: scope.notifications
      })
    }
    return Object.freeze({
      scopes: Object.freeze(scopes),
      ...(stored.properties === undefined ? {} : { properties: stored.properties })
    })
  }

  private async getScopeAccounts(
    origin: string,
    scope: SupportedScope
  ): Promise<readonly string[]> {
    switch (scope.family) {
      case 'zcash':
        return this.options.zcash.getSessionAccounts(origin)
      case 'evm':
        return this.options.evm.getSessionAccounts(origin, scope.chainId)
      case 'bitcoin':
        return this.options.bitcoinEnabled === false
          ? Object.freeze([])
          : this.options.bitcoin.getSessionAccounts(origin)
      case 'solana':
        return this.options.solana?.getSessionAccounts(origin) ?? Object.freeze([])
      case 'near':
        return this.options.near?.getSessionAccounts(origin) ?? Object.freeze([])
    }
  }

  private async invokeMethod(
    params: unknown,
    origin: string,
    tabInfo: MultichainSessionTabInfo
  ): Promise<unknown> {
    const parsed = parseCaip27InvokeMethodRequest(params)
    const stored = await this.options.manager.getCaip25Session(origin)
    const granted = stored?.scopes.find(scope => scope.chainId === parsed.scope)
    if (!granted) throw new Caip25ProviderError(4100, `Scope ${parsed.scope} is not authorized.`)
    if (!granted.methods.includes(parsed.request.method)) {
      throw new Caip25ProviderError(
        4100,
        `${parsed.request.method} is not authorized for scope ${parsed.scope}.`
      )
    }
    const supported = this.getSupportedScope(parsed.scope)
    if (
      supported.family === 'evm' &&
      (this.options.getActiveEvmChainId
        ? await this.options.getActiveEvmChainId(origin)
        : this.options.evm.getCaip2ChainId()) !== parsed.scope
    ) {
      throw new Caip25ProviderError(
        4901,
        `Switch Noir Wallet to ${supported.chainName} before invoking this scope.`
      )
    }
    return this.options.dispatch(
      supported.family,
      {
        method: parsed.request.method,
        ...(parsed.request.params === undefined ? {} : { params: parsed.request.params })
      },
      origin,
      tabInfo,
      parsed.scope
    )
  }
}
