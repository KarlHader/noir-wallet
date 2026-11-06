import type {
  ZcashProvider,
  ZcashAddress,
  ZcashAccount,
  ZcashAccountBalance,
  ZcashConnectResult,
  ZcashBalanceResult,
  Balance,
  SendTransactionParams,
  MaxTransferParams,
  MaxTransferEstimate,
  SignMessageOptions,
  SignMessageResult,
  SigningMode,
  ConnectionSigningMode,
  ConnectionOptions,
  ConnectedIdentities,
  QueriedIdentities,
  LendingMcaStatus,
  Network,
  PublicAccount,
  PublicAssets,
  PublicTransaction,
  SendPublicTransactionParams
} from './types'

type AccountEventOptions = { readonly signingMode: ConnectionSigningMode }

function accountEventName(event: string, options?: AccountEventOptions): string {
  if (options === undefined) return event
  if (
    !options ||
    event !== 'accountsChanged' ||
    (options.signingMode !== 'current' && options.signingMode !== 'noir_protocol_public')
  ) {
    throw new TypeError('Unknown event signing mode.')
  }
  return options.signingMode === 'noir_protocol_public' ? 'publicAccountChanged' : event
}

function readConnectionOptions(
  options: ConnectionOptions
):
  | { kind: 'single'; mode: ConnectionSigningMode }
  | { kind: 'multiple'; modes: readonly ConnectionSigningMode[] } {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Invalid connection options.')
  }
  if (Object.keys(options).some(key => key !== 'signingMode' && key !== 'signingModes')) {
    throw new TypeError('Invalid connection options.')
  }
  const hasMode = Object.prototype.hasOwnProperty.call(options, 'signingMode')
  const hasModes = Object.prototype.hasOwnProperty.call(options, 'signingModes')
  if (hasMode === hasModes) throw new TypeError('Select exactly one signingMode or signingModes.')
  if (hasMode) {
    if (options.signingMode !== 'current' && options.signingMode !== 'noir_protocol_public') {
      throw new TypeError('Unknown connection signing mode.')
    }
    return { kind: 'single', mode: options.signingMode }
  }
  const modes = options.signingModes
  if (
    !Array.isArray(modes) ||
    modes.length === 0 ||
    Array.from(modes).some(mode => mode !== 'current' && mode !== 'noir_protocol_public') ||
    new Set(modes).size !== modes.length
  ) {
    throw new TypeError('Connection signingModes must be distinct supported modes.')
  }
  return { kind: 'multiple', modes }
}

function readSigningMode(options?: SignMessageOptions): SigningMode {
  if (options === undefined) return 'current'
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(key => key !== 'signingMode')
  ) {
    throw new TypeError('Invalid signing options.')
  }
  const mode = options.signingMode === undefined ? 'current' : options.signingMode
  if (
    mode !== 'current' &&
    mode !== 'derived' &&
    mode !== 'legacy_index0' &&
    mode !== 'noir_protocol_public'
  ) {
    throw new TypeError('Unknown signing mode.')
  }
  return mode
}

function isZcashAddress(value: unknown): value is ZcashAddress {
  return (
    !!value &&
    typeof value === 'object' &&
    'transparent' in value &&
    typeof value.transparent === 'string' &&
    'shielded' in value &&
    typeof value.shielded === 'string'
  )
}

function isPublicAccount(value: unknown): value is PublicAccount {
  return (
    !!value &&
    typeof value === 'object' &&
    'chain' in value &&
    value.chain === 'zcash-l2' &&
    'network' in value &&
    (value.network === 'mainnet' || value.network === 'testnet') &&
    'publicKey' in value &&
    typeof value.publicKey === 'string' &&
    'address' in value &&
    typeof value.address === 'string' &&
    'mcaId' in value &&
    (value.mcaId === null || typeof value.mcaId === 'string') &&
    'parentContractId' in value &&
    typeof value.parentContractId === 'string' &&
    'status' in value &&
    (value.status === 'inactive' || value.status === 'activating' || value.status === 'active')
  )
}

function isZcashConnectResult(value: unknown): value is ZcashConnectResult {
  return (
    isZcashAddress(value) &&
    'accounts' in value &&
    Array.isArray(value.accounts) &&
    value.accounts.length > 0 &&
    value.accounts.every(
      account =>
        account &&
        typeof account.id === 'string' &&
        typeof account.label === 'string' &&
        typeof account.walletId === 'string' &&
        typeof account.accountId === 'string' &&
        isZcashAddress(account.addresses)
    )
  )
}

function readCombinedConnection(value: unknown): {
  current: ZcashConnectResult
  noir_protocol_public: PublicAccount
} {
  const identities =
    value && typeof value === 'object' && 'identities' in value ? value.identities : null
  const current =
    identities && typeof identities === 'object' && 'current' in identities
      ? identities.current
      : null
  const publicAccount =
    identities && typeof identities === 'object' && 'noir_protocol_public' in identities
      ? identities.noir_protocol_public
      : null
  if (!isZcashConnectResult(current) || !isPublicAccount(publicAccount)) {
    throw new TypeError('Invalid combined connection response.')
  }
  return { current, noir_protocol_public: publicAccount }
}

/** High-level Zcash SDK client built on top of the injected request provider. */
export class ZcashClient {
  private provider: ZcashProvider

  constructor(provider: ZcashProvider) {
    this.provider = provider
  }

  /**
   * Wrap a raw single-account address response so callers always get an
   * `accounts` array. New extensions already include `accounts`; older ones
   * return only `{ transparent, shielded }`, which we normalize to a
   * one-element array for forward-compatible consumers.
   */
  private normalizeConnect<T extends ZcashAddress | null>(res: T): ZcashConnectResult | null {
    if (!res) return null
    const r = res as ZcashAddress & { accounts?: ZcashAccount[] }
    if (Array.isArray(r.accounts)) return r as ZcashConnectResult
    return {
      transparent: r.transparent,
      shielded: r.shielded,
      accounts: [
        {
          id: 'current',
          label: 'Current Account',
          walletId: '',
          accountId: '',
          addresses: { transparent: r.transparent, shielded: r.shielded }
        }
      ]
    }
  }

  /** Same forward-compat normalization as {@link normalizeConnect} for balances. */
  private normalizeBalance(res: Balance): ZcashBalanceResult {
    const r = res as Balance & { accounts?: ZcashAccountBalance[] }
    if (Array.isArray(r.accounts)) return r as ZcashBalanceResult
    return {
      ...r,
      accounts: [{ id: 'current', walletId: '', accountId: '', balance: r, synced: true }]
    }
  }

  /**
   * Request wallet connection. Shows an approval screen where the user can
   * authorize one or several independent wallets (MetaMask-style: the current
   * account is selected by default, more can be added). The top-level
   * `transparent`/`shielded` are the primary account; `accounts` lists every
   * authorized wallet's addresses.
   */
  connect(): Promise<ZcashConnectResult>
  connect(options: { readonly signingMode: 'current' }): Promise<ZcashConnectResult>
  connect(options: { readonly signingMode: 'noir_protocol_public' }): Promise<PublicAccount>
  connect(options: {
    readonly signingMode: ConnectionSigningMode
  }): Promise<ZcashConnectResult | PublicAccount>
  connect(options: {
    readonly signingModes: readonly ConnectionSigningMode[]
  }): Promise<ConnectedIdentities>
  connect(
    options?: ConnectionOptions
  ): Promise<ZcashConnectResult | PublicAccount | ConnectedIdentities>
  async connect(
    options?: ConnectionOptions
  ): Promise<ZcashConnectResult | PublicAccount | ConnectedIdentities> {
    if (options !== undefined) {
      const selection = readConnectionOptions(options)
      if (selection.kind === 'single') {
        if (selection.mode === 'noir_protocol_public') {
          this.requirePublicCapability()
          return this.requestPublicAccount()
        }
      } else {
        if (selection.modes.includes('noir_protocol_public')) this.requirePublicCapability()
        if (selection.modes.length === 1) {
          if (selection.modes[0] === 'noir_protocol_public') {
            return { identities: { noir_protocol_public: await this.requestPublicAccount() } }
          }
          return { identities: { current: await this.requestCurrentAccounts() } }
        }
        const response: unknown = await this.provider.request({
          method: 'zcash_requestPublicAccount',
          params: [{ signingModes: ['current', 'noir_protocol_public'] }]
        })
        return { identities: readCombinedConnection(response) }
      }
    }
    return this.requestCurrentAccounts()
  }

  private async requestCurrentAccounts(): Promise<ZcashConnectResult> {
    const res = await this.provider.request({ method: 'zcash_requestAccounts' })
    return this.normalizeConnect(res) as ZcashConnectResult
  }

  private requestPublicAccount(): Promise<PublicAccount> {
    return this.provider.request({ method: 'zcash_requestPublicAccount' })
  }

  private requirePublicCapability(): void {
    if (!this.provider.supportedSigningModes?.includes('noir_protocol_public')) {
      throw new Error('This Noir Wallet provider does not support the Public signing mode.')
    }
  }

  /** Silently query the connected accounts (no popup). `null` when not connected. */
  getAccounts(): Promise<ZcashConnectResult | null>
  getAccounts(options: { readonly signingMode: 'current' }): Promise<ZcashConnectResult | null>
  getAccounts(options: {
    readonly signingMode: 'noir_protocol_public'
  }): Promise<PublicAccount | null>
  getAccounts(options: {
    readonly signingMode: ConnectionSigningMode
  }): Promise<ZcashConnectResult | PublicAccount | null>
  getAccounts(options: {
    readonly signingModes: readonly ConnectionSigningMode[]
  }): Promise<QueriedIdentities>
  getAccounts(
    options?: ConnectionOptions
  ): Promise<ZcashConnectResult | PublicAccount | null | QueriedIdentities>
  async getAccounts(
    options?: ConnectionOptions
  ): Promise<ZcashConnectResult | PublicAccount | null | QueriedIdentities> {
    if (options !== undefined) {
      const selection = readConnectionOptions(options)
      if (selection.kind === 'single') {
        if (selection.mode === 'noir_protocol_public') {
          this.requirePublicCapability()
          return this.queryPublicAccount()
        }
      } else {
        if (selection.modes.includes('noir_protocol_public')) this.requirePublicCapability()
        const identities: QueriedIdentities['identities'] = {}
        if (selection.modes.includes('current'))
          identities.current = await this.queryCurrentAccounts()
        if (selection.modes.includes('noir_protocol_public')) {
          identities.noir_protocol_public = await this.queryPublicAccount()
        }
        return { identities }
      }
    }
    return this.queryCurrentAccounts()
  }

  private async queryCurrentAccounts(): Promise<ZcashConnectResult | null> {
    const res = await this.provider.request({ method: 'zcash_getAccounts' })
    return this.normalizeConnect(res)
  }

  private queryPublicAccount(): Promise<PublicAccount | null> {
    return this.provider.request({ method: 'zcash_getPublicAccount' })
  }

  /**
   * Get wallet balance. With no argument returns the primary account's balance;
   * pass an account `id` (the `${walletId}:${accountId}` key from `accounts`) to
   * read a specific authorized account. The `accounts` field always carries the
   * balance of every authorized account.
   */
  async getBalance(accountId?: string): Promise<ZcashBalanceResult> {
    const res = await this.provider.request({
      method: 'zcash_getBalance',
      params: accountId ? [{ accountId }] : []
    })
    return this.normalizeBalance(res)
  }

  /** Get the exact send-max amount and fee for a destination and fee tier. */
  async getMaxTransfer(params: MaxTransferParams): Promise<MaxTransferEstimate> {
    return this.provider.request({
      method: 'zcash_getMaxTransfer',
      params: [params]
    })
  }

  /** Get the connected wallet's transparent and shielded addresses. */
  async getAddresses(): Promise<ZcashAddress> {
    return this.provider.request({ method: 'zcash_getAddresses' })
  }

  async getPublicKey(options?: SignMessageOptions): Promise<{
    pubkey: string
    address: string
    signingMode: SigningMode
    originAddress?: string
  } | null> {
    const signingMode = readSigningMode(options)
    if (signingMode === 'noir_protocol_public') this.requirePublicCapability()
    return this.provider.request({
      method: 'zcash_getPublicKey',
      params: [{ signingMode }]
    })
  }

  async sendTransaction(params: SendTransactionParams): Promise<string> {
    return this.provider.request({
      method: 'zcash_sendTransaction',
      params: [params]
    })
  }

  async signMessage(message: string, options?: SignMessageOptions): Promise<SignMessageResult> {
    const signingMode = readSigningMode(options)
    if (signingMode === 'noir_protocol_public') this.requirePublicCapability()
    return this.provider.request({
      method: 'zcash_signMessage',
      params: [message, { signingMode }]
    })
  }

  /** Shield transparent funds to the private (shielded) balance. Requires user approval. */
  async shieldFunds(): Promise<string> {
    return this.provider.request({ method: 'zcash_shieldFunds' })
  }

  async activatePublicAccount(): Promise<PublicAccount> {
    return this.provider.request({ method: 'zcash_activatePublicAccount' })
  }

  async getPublicAssets(): Promise<PublicAssets> {
    return this.provider.request({ method: 'zcash_getPublicAssets' })
  }

  async sendPublicTransaction(params: SendPublicTransactionParams): Promise<PublicTransaction> {
    return this.provider.request({ method: 'zcash_sendPublicTransaction', params: [params] })
  }

  async getPublicTransaction(operationId: string): Promise<PublicTransaction | null> {
    return this.provider.request({ method: 'zcash_getPublicTransaction', params: [operationId] })
  }

  /** @deprecated Global network mode is controlled in Noir Wallet settings. */
  async switchNetwork(_network: Network): Promise<never> {
    throw new Error(
      'switchNetwork() is deprecated. Change global network mode in Noir Wallet settings; the extension will restart before using the selected mode.'
    )
  }

  async checkLendingMcaAccount(): Promise<LendingMcaStatus | null> {
    return this.provider.request({ method: 'zcash_checkLendingMcaAccount' })
  }

  async disconnect(options?: ConnectionOptions): Promise<void> {
    if (options !== undefined) {
      const selection = readConnectionOptions(options)
      const modes = selection.kind === 'single' ? [selection.mode] : selection.modes
      if (modes.includes('noir_protocol_public')) this.requirePublicCapability()
      if (modes.includes('current')) await this.provider.request({ method: 'zcash_disconnect' })
      if (modes.includes('noir_protocol_public'))
        await this.provider.request({ method: 'zcash_disconnectPublic' })
      return
    }
    await this.provider.request({ method: 'zcash_disconnect' })
  }

  on(
    event: 'accountsChanged',
    handler: (account: ZcashAddress | null) => void,
    options: { readonly signingMode: 'current' }
  ): void
  on(
    event: 'accountsChanged',
    handler: (account: PublicAccount | null) => void,
    options: { readonly signingMode: 'noir_protocol_public' }
  ): void
  on(event: string, handler: (...args: any[]) => void): void
  on(event: string, handler: (...args: any[]) => void, options?: AccountEventOptions): void {
    this.provider.on(accountEventName(event, options), handler)
  }

  removeListener(
    event: 'accountsChanged',
    handler: (account: ZcashAddress | null) => void,
    options: { readonly signingMode: 'current' }
  ): void
  removeListener(
    event: 'accountsChanged',
    handler: (account: PublicAccount | null) => void,
    options: { readonly signingMode: 'noir_protocol_public' }
  ): void
  removeListener(event: string, handler: (...args: any[]) => void): void
  removeListener(
    event: string,
    handler: (...args: any[]) => void,
    options?: AccountEventOptions
  ): void {
    const rawEvent = accountEventName(event, options)
    this.provider.removeListener?.(rawEvent, handler)
  }
}

/** @deprecated Use {@link ZcashClient}. */
export type ZcashAPI = ZcashClient

/** @deprecated Use {@link ZcashClient}. */
export const ZcashAPI = ZcashClient
