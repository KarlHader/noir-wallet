import { getStarknetNetworkConfig } from '@/core/chains/starknet/network-config'
import { STARKNET_CHAIN_IDS } from '@/core/chains/starknet/identifiers'
import {
  STARKNET_ERROR,
  STARKNET_SUPPORTED_JSON_RPC_SPECS,
  STARKNET_WALLET_API_VERSION,
  StarknetProviderError,
  assertStarknetApiVersion,
  isUnsupportedStarknetMethod,
  parseStarknetCalls,
  parseStarknetFelt,
  parseStarknetTypedData,
  readStarknetParams,
  toStarknetWorkerCall,
  type StarknetDAppRuntimeMethod,
  type StarknetWorkerCall
} from '@/core/dapp/starknet-provider'
import type { AccountRef } from '@/core/dapp/dapp-manager'
import {
  selectDAppSessionAccounts,
  type DAppSessionAccountProposal,
  type DAppSessionAccountSelection
} from './dapp-session-accounts'
import type { Network } from '@/types'
import {
  ARGENT_V04_CLASS_HASH,
  ARGENT_V05_CLASS_HASH,
  LEDGER_STARKNET_MAX_CALLS,
  isClearSignedStarknetTransfer,
  normalizeStarknetLedgerFelt
} from '@/lib/ledger/starknet-model'

const OZ_CLASS_HASH = '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564'

export interface StarknetActiveAccount {
  readonly address: string
  readonly publicKey: string
  readonly classHash: string
  readonly implementation: 'open_zeppelin' | 'argent_v0_4' | 'argent_v0_5'
  readonly accountIndex: number
  readonly addressIndex: number
  readonly keyDomainId: string
  readonly accountId: string
  readonly keySource?: 'software' | 'ledger'
}

export interface StarknetResourceBound {
  readonly maxAmount: string
  readonly maxPricePerUnit: string
}

export interface StarknetDeployQuote {
  readonly nonce: string
  readonly resourceBounds: {
    readonly l1Gas: StarknetResourceBound
    readonly l2Gas: StarknetResourceBound
    readonly l1DataGas: StarknetResourceBound
  }
}

export interface StarknetInvokeQuote {
  readonly nonce: string
  readonly resourceBounds: {
    readonly l1Gas: StarknetResourceBound
    readonly l2Gas: StarknetResourceBound
    readonly l1DataGas: StarknetResourceBound
  }
  readonly tip?: string
  readonly deploy?: StarknetDeployQuote
}

export interface StarknetInvokeQuoter {
  quote(input: {
    readonly chainId: string
    readonly accountAddress: string
    readonly calls: readonly StarknetWorkerCall[]
  }): Promise<StarknetInvokeQuote>
}

export interface StarknetLedgerSigner {
  submitInvoke(input: {
    readonly account: StarknetActiveAccount
    readonly chainId: 'starknet:SN_MAIN' | 'starknet:SN_SEPOLIA'
    readonly calls: readonly StarknetWorkerCall[]
    readonly quote: StarknetInvokeQuote
    readonly blindSigning: boolean
  }): Promise<{ readonly transactionHash: string }>
  signTypedData(input: {
    readonly account: StarknetActiveAccount
    readonly chainId: 'starknet:SN_MAIN' | 'starknet:SN_SEPOLIA'
    readonly typedData: Readonly<Record<string, unknown>>
  }): Promise<readonly [string, string]>
}

export interface StarknetSessionSigner {
  prepare(
    payload: Readonly<Record<string, unknown>>
  ): Promise<{ readonly signingCommandId: string }>
  confirmInvoke(signingCommandId: string): Promise<{ readonly transactionHash: string }>
  confirmTypedData(
    signingCommandId: string
  ): Promise<{ readonly signature: readonly [string, string] }>
}

export interface StarknetDAppHandlerOptions {
  readonly getNetwork: () => Network
  readonly isUnlocked: () => boolean
  readonly ensureUnlocked: () => Promise<void>
  readonly getAccount: () => StarknetActiveAccount | null | Promise<StarknetActiveAccount | null>
  readonly requestApproval: (
    origin: string,
    action: 'starknetConnect' | 'starknetTransaction' | 'starknetMessage',
    data: Readonly<Record<string, unknown>>
  ) => Promise<{ readonly approved: boolean }>
  readonly quoteInvoke: StarknetInvokeQuoter | null
  readonly signer: StarknetSessionSigner | null
  readonly ledger?: StarknetLedgerSigner | null
  readonly broadcast: (
    origin: string,
    eventName: 'accountsChanged' | 'networkChanged',
    data: unknown
  ) => Promise<void>
}

interface StarknetPermission {
  readonly network: Network
  readonly address: string
  readonly accountId: string
}

const permissions = new Map<string, StarknetPermission>()
let boundHandler: StarknetDAppHandler | null = null

export function revokeStarknetOrigin(origin: string): void {
  if (!permissions.delete(origin)) return
  const handler = boundHandler
  if (!handler) return
  void handler.emit(origin, 'accountsChanged', [])
}

export function revokeAllStarknetPermissions(): void {
  const origins = [...permissions.keys()]
  permissions.clear()
  const handler = boundHandler
  if (!handler) return
  for (const origin of origins) void handler.emit(origin, 'accountsChanged', [])
}

export class StarknetDAppHandler {
  private pendingSessionOrigin: string | null = null

  constructor(private readonly options: StarknetDAppHandlerOptions) {
    boundHandler = this
  }

  emit(
    origin: string,
    eventName: 'accountsChanged' | 'networkChanged',
    data: unknown
  ): Promise<void> {
    return this.options.broadcast(origin, eventName, data)
  }

  revokeOrigin(origin: string): void {
    revokeStarknetOrigin(origin)
  }

  revokeAllPermissions(): void {
    revokeAllStarknetPermissions()
  }

  async request(
    request: {
      readonly method: StarknetDAppRuntimeMethod | string
      readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
    },
    origin: string
  ): Promise<unknown> {
    try {
      if (isUnsupportedStarknetMethod(request.method)) {
        throw new StarknetProviderError(
          STARKNET_ERROR.unavailable,
          `${request.method} is not supported.`
        )
      }
      const params = readStarknetParams(request.params)
      assertStarknetApiVersion(params)
      switch (request.method) {
        case 'wallet_supportedWalletApi':
          return Object.freeze([STARKNET_WALLET_API_VERSION])
        case 'wallet_supportedSpecs':
          return STARKNET_SUPPORTED_JSON_RPC_SPECS
        case 'wallet_getPermissions':
          return await this.permissionsFor(origin)
        case 'wallet_requestAccounts':
          return this.requestAccounts(origin, params)
        case 'wallet_requestChainId':
          return this.feltChainId()
        case 'wallet_deploymentData':
          return await this.deploymentData(origin)
        case 'wallet_switchStarknetChain':
          return this.switchChain(params)
        case 'wallet_watchAsset':
          return this.watchAsset(params)
        case 'wallet_addInvokeTransaction':
          return this.addInvoke(origin, params)
        case 'wallet_signTypedData':
          return this.signTypedData(origin, params)
        case 'wallet_disconnect':
          this.revokeOrigin(origin)
          return null
        default:
          throw new StarknetProviderError(
            STARKNET_ERROR.unavailable,
            `${request.method} is not supported.`
          )
      }
    } catch (error) {
      if (error instanceof StarknetProviderError) throw error
      throw new StarknetProviderError(
        STARKNET_ERROR.unknown,
        'Noir Wallet could not complete the Starknet request.'
      )
    }
  }

  async prepareSessionAccountSelection(origin: string): Promise<DAppSessionAccountProposal> {
    await this.options.ensureUnlocked()
    const account = await this.requireAccount()
    const config = this.networkConfig()
    this.pendingSessionOrigin = origin
    const option = Object.freeze({
      id: account.accountId,
      label: 'Starknet',
      address: account.address,
      reference: Object.freeze({
        walletId: account.keyDomainId,
        accountId: account.accountId
      }) satisfies AccountRef,
      required: true
    })
    return Object.freeze({
      chainId: config.chainId,
      chainName: config.displayName,
      iconChain: 'starknet',
      accounts: Object.freeze([option]),
      preselectedIds: Object.freeze([option.id]),
      activeReference: option.reference,
      activeAddress: account.address
    })
  }

  async resolveSessionAccountSelection(
    proposal: DAppSessionAccountProposal,
    selectedIds: readonly string[]
  ): Promise<DAppSessionAccountSelection> {
    const account = await this.requireAccount()
    const origin = this.pendingSessionOrigin
    this.pendingSessionOrigin = null
    if (account.address !== proposal.activeAddress) {
      throw new StarknetProviderError(
        STARKNET_ERROR.unknown,
        'The active Starknet account changed. Review this request again.'
      )
    }
    if (origin) this.grant(origin, account)
    return selectDAppSessionAccounts(proposal, selectedIds)
  }

  async getSessionAccounts(origin: string): Promise<readonly string[]> {
    const permission = permissions.get(origin)
    const account = await this.options.getAccount()
    if (
      !permission ||
      !account ||
      permission.network !== this.options.getNetwork() ||
      permission.address !== account.address
    ) {
      return Object.freeze([])
    }
    return Object.freeze([account.address])
  }

  private async requestAccounts(
    origin: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<readonly string[]> {
    const silent = params.silent_mode === true
    if (params.silent_mode !== undefined && typeof params.silent_mode !== 'boolean') {
      throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid silent_mode.')
    }
    if (params.force_review !== undefined && typeof params.force_review !== 'boolean') {
      throw new StarknetProviderError(STARKNET_ERROR.invalidPayload, 'Invalid force_review.')
    }
    const forceReview = params.force_review === true
    if (silent) {
      if (!this.options.isUnlocked() || !(await this.permissionMatches(origin))) {
        return Object.freeze([])
      }
      return Object.freeze([(await this.requireAccount()).address])
    }
    await this.options.ensureUnlocked()
    const account = await this.requireAccount()
    if (forceReview || !(await this.permissionMatches(origin))) {
      const decision = await this.options.requestApproval(origin, 'starknetConnect', {
        address: account.address,
        chainId: this.feltChainId(),
        accounts: [
          {
            id: account.accountId,
            label: 'Starknet',
            address: account.address,
            required: true
          }
        ]
      })
      if (!decision.approved) {
        throw new StarknetProviderError(
          STARKNET_ERROR.userRefused,
          'The Starknet request was rejected.'
        )
      }
      await this.revalidateAccount(account)
      this.grant(origin, account)
    }
    return Object.freeze([account.address])
  }

  private async deploymentData(origin: string): Promise<{
    readonly address: string
    readonly class_hash: string
    readonly salt: string
    readonly calldata: readonly string[]
    readonly version: 1
  }> {
    if (!this.options.isUnlocked() || !(await this.permissionMatches(origin))) {
      throw new StarknetProviderError(
        STARKNET_ERROR.deploymentDataUnavailable,
        'Starknet deployment data is not available.'
      )
    }
    const account = await this.requireAccount()
    await this.revalidateAccount(account)
    if (account.implementation === 'argent_v0_5') {
      throw new StarknetProviderError(
        STARKNET_ERROR.accountAlreadyDeployed,
        'This Starknet account is already deployed.'
      )
    }
    const publicKey = parseStarknetFelt(account.publicKey, 'public key')
    const presetClass =
      account.implementation === 'argent_v0_4' ? ARGENT_V04_CLASS_HASH : OZ_CLASS_HASH
    const classHash = parseStarknetFelt(account.classHash || presetClass, 'class hash')
    return Object.freeze({
      address: parseStarknetFelt(account.address, 'account address'),
      class_hash: classHash,
      salt: publicKey,
      calldata: Object.freeze(
        account.implementation === 'argent_v0_4' ? ['0x0', publicKey, '0x1'] : [publicKey]
      ),
      version: 1 as const
    })
  }

  private switchChain(params: Readonly<Record<string, unknown>>): true {
    const requested = parseStarknetFelt(params.chainId, 'chain id')
    if (requested !== this.feltChainId()) {
      throw new StarknetProviderError(
        STARKNET_ERROR.chainIdNotSupported,
        'The requested Starknet chain does not match the wallet network mode.'
      )
    }
    return true
  }

  private watchAsset(params: Readonly<Record<string, unknown>>): true {
    if (params.type !== 'ERC20' || !isRecord(params.options)) {
      throw new StarknetProviderError(
        STARKNET_ERROR.notErc20,
        'Only a registered ERC20 can be watched.'
      )
    }
    let address: string
    try {
      address = parseStarknetFelt(params.options.address, 'asset address')
    } catch {
      throw new StarknetProviderError(
        STARKNET_ERROR.notErc20,
        'Only a registered ERC20 can be watched.'
      )
    }
    const known = this.networkConfig().tokens.some(token => token.reference === address)
    if (!known) {
      throw new StarknetProviderError(
        STARKNET_ERROR.invalidPayload,
        'This Starknet asset is not registered.'
      )
    }
    return true
  }

  private async addInvoke(
    origin: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<{ readonly transaction_hash: string }> {
    if (
      Object.prototype.hasOwnProperty.call(params, 'proof') ||
      Object.prototype.hasOwnProperty.call(params, 'proofFacts')
    ) {
      throw new StarknetProviderError(
        STARKNET_ERROR.invalidPayload,
        'Starknet invoke transactions cannot include a proof.'
      )
    }
    const calls = parseStarknetCalls(params.invoke_transaction)
    const workerCalls = Object.freeze(calls.map(toStarknetWorkerCall))
    await this.ensurePermission(origin)
    const account = await this.requireAccount()
    const quoter = this.options.quoteInvoke
    const ledger = account.keySource === 'ledger'
    if (ledger) this.assertLedgerAccount(account)
    if (ledger && calls.length > LEDGER_STARKNET_MAX_CALLS) {
      throw new StarknetProviderError(
        STARKNET_ERROR.invalidPayload,
        'A Ledger Starknet transaction can include at most 8 calls.'
      )
    }
    const signer = this.options.signer
    if (!quoter || (ledger ? !this.options.ledger : !signer)) {
      throw new StarknetProviderError(
        STARKNET_ERROR.unknown,
        ledger
          ? 'Starknet Ledger signing is not connected.'
          : 'Starknet transaction signing is not connected.'
      )
    }
    const chainId = this.productChainId()
    const quote = await quoter.quote({
      chainId,
      accountAddress: account.address,
      calls: workerCalls
    })
    const decision = await this.options.requestApproval(origin, 'starknetTransaction', {
      address: account.address,
      chainId: this.feltChainId(),
      networkName: this.networkConfig().displayName,
      calls: calls.map(call => ({
        contract_address: call.contract_address,
        entry_point: call.entry_point,
        calldata: [...call.calldata]
      })),
      nonce: quote.nonce,
      resourceBounds: quote.resourceBounds,
      ...(quote.deploy ? { deploysAccount: true } : {})
    })
    if (!decision.approved) {
      throw new StarknetProviderError(
        STARKNET_ERROR.userRefused,
        'The Starknet request was rejected.'
      )
    }
    await this.revalidateForSign(origin, account)
    if (ledger) {
      const submitted = await this.options.ledger!.submitInvoke({
        account,
        chainId,
        calls: workerCalls,
        quote,
        blindSigning: !isClearSignedStarknetTransfer(
          calls.map(call => ({
            contract: call.contract_address,
            selector: call.entry_point.startsWith('0x') ? call.entry_point : undefined,
            entrypoint: call.entry_point.startsWith('0x') ? undefined : call.entry_point,
            calldata: call.calldata
          }))
        )
      })
      return Object.freeze({
        transaction_hash: parseStarknetFelt(submitted.transactionHash, 'transaction hash')
      })
    }
    const prepared = await signer!.prepare(invokePayload(account, chainId, workerCalls, quote))
    const confirmed = await signer!.confirmInvoke(prepared.signingCommandId)
    return Object.freeze({
      transaction_hash: parseStarknetFelt(confirmed.transactionHash, 'transaction hash')
    })
  }

  private async signTypedData(
    origin: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<readonly [string, string]> {
    const typedData = parseStarknetTypedData(params.typed_data)
    await this.ensurePermission(origin)
    const account = await this.requireAccount()
    const ledger = account.keySource === 'ledger'
    if (ledger) this.assertLedgerAccount(account)
    const signer = this.options.signer
    if (ledger ? !this.options.ledger : !signer) {
      throw new StarknetProviderError(
        STARKNET_ERROR.unknown,
        ledger
          ? 'Starknet Ledger signing is not connected.'
          : 'Starknet typed-data signing is not connected.'
      )
    }
    const decision = await this.options.requestApproval(origin, 'starknetMessage', {
      address: account.address,
      chainId: this.feltChainId(),
      networkName: this.networkConfig().displayName,
      primaryType: typedData.primaryType,
      message: readStarknetApprovalMessage(typedData)
    })
    if (!decision.approved) {
      throw new StarknetProviderError(
        STARKNET_ERROR.userRefused,
        'The Starknet request was rejected.'
      )
    }
    await this.revalidateForSign(origin, account)
    if (ledger) {
      return this.options.ledger!.signTypedData({
        account,
        chainId: this.productChainId(),
        typedData
      })
    }
    const prepared = await signer!.prepare({
      kind: 'starknet-typed-data',
      chainId: this.productChainId(),
      accountIndex: account.accountIndex,
      addressIndex: account.addressIndex,
      classHash: account.classHash,
      typedData
    })
    const confirmed = await signer!.confirmTypedData(prepared.signingCommandId)
    return Object.freeze([
      parseStarknetFelt(confirmed.signature[0], 'signature r'),
      parseStarknetFelt(confirmed.signature[1], 'signature s')
    ])
  }

  private async ensurePermission(origin: string): Promise<void> {
    if (await this.permissionMatches(origin)) return
    await this.requestAccounts(origin, {})
  }

  private async permissionMatches(origin: string): Promise<boolean> {
    const permission = permissions.get(origin)
    const account = await this.options.getAccount()
    return Boolean(
      permission &&
      account &&
      permission.network === this.options.getNetwork() &&
      permission.address === account.address &&
      permission.accountId === account.accountId
    )
  }

  private async permissionsFor(origin: string): Promise<readonly ['accounts'] | readonly []> {
    const granted = Object.freeze(['accounts'] as const)
    const empty = Object.freeze([] as const)
    return (await this.permissionMatches(origin)) ? granted : empty
  }

  private grant(origin: string, account: StarknetActiveAccount): void {
    permissions.set(
      origin,
      Object.freeze({
        network: this.options.getNetwork(),
        address: account.address,
        accountId: account.accountId
      })
    )
    void this.emit(origin, 'accountsChanged', [account.address])
  }

  private async requireAccount(): Promise<StarknetActiveAccount> {
    const account = await this.options.getAccount()
    if (!account) {
      throw new StarknetProviderError(STARKNET_ERROR.unknown, 'No Starknet account is selected.')
    }
    return account
  }

  private async revalidateAccount(expected: StarknetActiveAccount): Promise<void> {
    const account = await this.requireAccount()
    if (
      account.address !== expected.address ||
      account.accountId !== expected.accountId ||
      account.publicKey !== expected.publicKey ||
      account.classHash !== expected.classHash
    ) {
      throw new StarknetProviderError(
        STARKNET_ERROR.unknown,
        'The active Starknet account changed. Review this request again.'
      )
    }
  }

  private assertLedgerAccount(account: StarknetActiveAccount): void {
    const classHash = normalizeStarknetLedgerFelt(account.classHash)
    const allowed =
      classHash === normalizeStarknetLedgerFelt(ARGENT_V04_CLASS_HASH) ||
      classHash === normalizeStarknetLedgerFelt(ARGENT_V05_CLASS_HASH)
    if (!allowed || account.implementation === 'open_zeppelin') {
      throw new StarknetProviderError(
        STARKNET_ERROR.unknown,
        'This Starknet account cannot be signed by Ledger.'
      )
    }
  }

  private async revalidateForSign(origin: string, expected: StarknetActiveAccount): Promise<void> {
    if (!(await this.permissionMatches(origin))) {
      throw new StarknetProviderError(
        STARKNET_ERROR.unauthorized,
        'This origin is not authorized for the active Starknet account.'
      )
    }
    await this.revalidateAccount(expected)
    if (this.feltChainId() !== getStarknetNetworkConfig(this.options.getNetwork()).feltChainId) {
      throw new StarknetProviderError(
        STARKNET_ERROR.chainIdNotSupported,
        'The requested Starknet chain does not match the wallet network mode.'
      )
    }
  }

  private networkConfig() {
    return getStarknetNetworkConfig(this.options.getNetwork())
  }

  private feltChainId(): string {
    return this.networkConfig().feltChainId
  }

  private productChainId(): 'starknet:SN_MAIN' | 'starknet:SN_SEPOLIA' {
    const network = this.options.getNetwork()
    return network === 'mainnet' ? STARKNET_CHAIN_IDS.mainnet : STARKNET_CHAIN_IDS.testnet
  }
}

function invokePayload(
  account: StarknetActiveAccount,
  chainId: string,
  calls: readonly StarknetWorkerCall[],
  quote: StarknetInvokeQuote
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: 'starknet-invoke',
    chainId,
    accountIndex: account.accountIndex,
    addressIndex: account.addressIndex,
    classHash: account.classHash,
    calls,
    nonce: quote.nonce,
    resourceBounds: quote.resourceBounds,
    ...(quote.tip === undefined ? {} : { tip: quote.tip })
  })
}

function readStarknetApprovalMessage(typedData: Readonly<Record<string, unknown>>): string {
  const message = typedData.message
  if (isRecord(message)) {
    const contents = message.contents
    if (typeof contents === 'string' && contents.length > 0) return contents
  }
  return typeof typedData.primaryType === 'string' ? typedData.primaryType : 'Typed data'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createStarknetDAppHandler(
  options: StarknetDAppHandlerOptions
): StarknetDAppHandler {
  return new StarknetDAppHandler(options)
}
