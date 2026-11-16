import { ANALYTICS_EVENTS } from '@/lib/analytics/constants'
import { emitDAppEvent, type DAppAnalyticsSink } from './dapp-analytics'
import type { EvmNetworkConfig } from '@/config/networks'
import { Eip1193ProviderError } from '@/core/dapp/eip1193'
import { getConfidentialFundingNetworkConfig } from '@/config/intents'
import { parseNearIntentsTransactionBinding, parseTransactionId } from '@/core/transactions/domain'
import { ConfidentialFundingApi } from './confidential-funding-api'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  resolveRheaPrivateTransferToken,
  type RheaSwapService,
  type RheaSwapSubmissionView
} from '@/core/services/rhea-swap'
import { parseRheaSwapTransactionBinding } from '@/core/transactions/domain'
import {
  ChromeSessionEvmPendingTransferStore,
  type EvmPendingTransferStore,
  type EvmTransferIntent,
  type PeaEvmExecutionAccount
} from '@/infrastructure/chains/evm'
import type { BackgroundEvmTransferController } from './evm-transfer-controller'
import type { RheaSwapEvmSignatureCoordinator } from './rhea-swap-evm-signature'

const DEFAULT_SLIPPAGE_BPS = 100
const DEFAULT_WAIT_MS = 15 * 60 * 1_000
const DEFAULT_POLL_MS = 5_000
const SUBMISSION_CACHE_MS = 20 * 60 * 1_000
const COMPLETED_CACHE_MS = 5 * 60 * 1_000
const SUBMISSION_PREFIX = 'evm_dapp_private_transfer:'

export interface EvmDAppPrivateTransferInput {
  readonly origin: string
  readonly chainId: string
  readonly account: Readonly<{
    keyDomainId: string
    accountId: string
    address: string
    addressIndex: number
  }>
  readonly intent: EvmTransferIntent
  readonly tokenContract?: string
  readonly tabInfo: Readonly<{ title?: string; favIconUrl?: string; pageUrl?: string }>
  readonly ensureIdentity: () => Promise<void>
}

export interface EvmDAppPrivateTransferPort {
  readonly send: (input: EvmDAppPrivateTransferInput) => Promise<string>
  readonly resumePending: (input: EvmDAppPrivateTransferInput) => Promise<string | null>
  readonly prepareExactOutput: (
    input: EvmDAppPrivateTransferInput
  ) => Promise<EvmDAppPrivateTransferPreparation>
}

export interface EvmDAppPrivateTransferPreparation {
  readonly approvalData: Readonly<Record<string, unknown>>
  execute(): Promise<string>
  cancel(): Promise<void>
}

interface ExactOutputSubmission {
  readonly schemaVersion: 2
  readonly fingerprint: string
  readonly depositAddress: string
  readonly destinationAmountRaw: string
  readonly sourceAmountRaw: string
  readonly destinationHash: string | null
  readonly transactionId: string
  readonly walletId: string
  readonly accountId: string
  readonly networkMode: 'mainnet' | 'testnet'
  readonly chainId: string
  readonly expiresAt: number
}

export interface ExactOutputSubmissionStore {
  readonly get: (fingerprint: string) => Promise<ExactOutputSubmission | null>
  readonly put: (submission: ExactOutputSubmission) => Promise<void>
  readonly delete: (fingerprint: string) => Promise<void>
}

const EXACT_OUTPUT_PREFIX = 'evm_dapp_exact_output:'

function parseExactOutputSubmission(value: unknown): ExactOutputSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored exact-output transfer is invalid')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !==
      'accountId,chainId,depositAddress,destinationAmountRaw,destinationHash,expiresAt,fingerprint,networkMode,schemaVersion,sourceAmountRaw,transactionId,walletId' ||
    record.schemaVersion !== 2 ||
    typeof record.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.fingerprint) ||
    typeof record.depositAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(record.depositAddress) ||
    typeof record.destinationAmountRaw !== 'string' ||
    !/^[1-9][0-9]{0,77}$/.test(record.destinationAmountRaw) ||
    typeof record.sourceAmountRaw !== 'string' ||
    !/^[1-9][0-9]{0,77}$/.test(record.sourceAmountRaw) ||
    (record.destinationHash !== null &&
      (typeof record.destinationHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(record.destinationHash))) ||
    typeof record.transactionId !== 'string' ||
    !record.transactionId.startsWith('transaction:evm:') ||
    typeof record.walletId !== 'string' ||
    !record.walletId ||
    record.walletId.length > 160 ||
    typeof record.accountId !== 'string' ||
    !record.accountId ||
    record.accountId.length > 160 ||
    (record.networkMode !== 'mainnet' && record.networkMode !== 'testnet') ||
    typeof record.chainId !== 'string' ||
    record.chainId.length > 32 ||
    !/^eip155:[1-9][0-9]*$/.test(record.chainId) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= 0
  ) {
    throw new Error('Stored exact-output transfer fields are invalid')
  }
  return record as unknown as ExactOutputSubmission
}

export class ChromeEvmDAppExactOutputStore implements ExactOutputSubmissionStore {
  async get(fingerprint: string): Promise<ExactOutputSubmission | null> {
    const value = (await chrome.storage.local.get(this.key(fingerprint)))[this.key(fingerprint)]
    if (value === undefined) return null
    const parsed = parseExactOutputSubmission(value)
    if (parsed.fingerprint !== fingerprint) throw new Error('Exact-output transfer key changed')
    if (parsed.destinationHash && parsed.expiresAt <= Date.now()) {
      await this.delete(fingerprint)
      return null
    }
    return parsed
  }

  async put(submission: ExactOutputSubmission): Promise<void> {
    const parsed = parseExactOutputSubmission(submission)
    await chrome.storage.local.set({ [this.key(parsed.fingerprint)]: parsed })
  }

  async delete(fingerprint: string): Promise<void> {
    await chrome.storage.local.remove(this.key(fingerprint))
  }

  private key(fingerprint: string): string {
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Exact-output key is invalid')
    return `${EXACT_OUTPUT_PREFIX}${fingerprint}`
  }
}

interface StoredSubmission {
  readonly schemaVersion: 1
  readonly fingerprint: string
  readonly quoteHandle: string
  readonly destinationHash: string | null
  readonly expiresAt: number
  readonly walletId?: string
  readonly accountId?: string
  readonly networkMode?: 'mainnet' | 'testnet'
}

export interface PrivateTransferSubmissionStore {
  readonly get: (fingerprint: string) => Promise<StoredSubmission | null>
  readonly put: (submission: StoredSubmission) => Promise<void>
  readonly delete: (fingerprint: string) => Promise<void>
}

function parseStoredSubmission(value: unknown): StoredSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored Confidential dApp transfer is invalid')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      key =>
        ![
          'schemaVersion',
          'fingerprint',
          'quoteHandle',
          'destinationHash',
          'expiresAt',
          'walletId',
          'accountId',
          'networkMode'
        ].includes(key)
    ) ||
    record.schemaVersion !== 1 ||
    typeof record.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.fingerprint) ||
    typeof record.quoteHandle !== 'string' ||
    !record.quoteHandle.startsWith('rhea-quote:') ||
    (record.destinationHash !== null &&
      (typeof record.destinationHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(record.destinationHash))) ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= 0 ||
    ([record.walletId, record.accountId, record.networkMode].some(value => value !== undefined) &&
      (typeof record.walletId !== 'string' ||
        !record.walletId ||
        record.walletId.length > 160 ||
        typeof record.accountId !== 'string' ||
        !record.accountId ||
        record.accountId.length > 160 ||
        (record.networkMode !== 'mainnet' && record.networkMode !== 'testnet')))
  ) {
    throw new Error('Stored Confidential dApp transfer fields are invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    fingerprint: record.fingerprint,
    quoteHandle: record.quoteHandle,
    destinationHash:
      record.destinationHash === null ? null : (record.destinationHash as string).toLowerCase(),
    expiresAt: record.expiresAt as number,
    ...(record.walletId === undefined
      ? {}
      : {
          walletId: record.walletId as string,
          accountId: record.accountId as string,
          networkMode: record.networkMode as 'mainnet' | 'testnet'
        })
  })
}

export class ChromeEvmDAppPrivateTransferStore implements PrivateTransferSubmissionStore {
  async get(fingerprint: string): Promise<StoredSubmission | null> {
    const key = this.key(fingerprint)
    const value =
      (await chrome.storage.local.get(key))[key] ?? (await chrome.storage.session.get(key))[key]
    if (value === undefined) return null
    const parsed = parseStoredSubmission(value)
    if (parsed.fingerprint !== fingerprint)
      throw new Error('Confidential dApp transfer key changed')
    if (parsed.destinationHash && parsed.expiresAt <= Date.now()) {
      await this.delete(fingerprint)
      return null
    }
    return parsed
  }

  async put(submission: StoredSubmission): Promise<void> {
    const parsed = parseStoredSubmission(submission)
    if (!parsed.walletId || !parsed.accountId || !parsed.networkMode) {
      throw new Error('Confidential dApp transfer scope is unavailable')
    }
    await chrome.storage.local.set({ [this.key(parsed.fingerprint)]: parsed })
    await chrome.storage.session.remove(this.key(parsed.fingerprint))
  }

  async delete(fingerprint: string): Promise<void> {
    const key = this.key(fingerprint)
    await Promise.all([chrome.storage.local.remove(key), chrome.storage.session.remove(key)])
  }

  async clearForAccount(walletId: string, accountId: string): Promise<void> {
    const stored = await chrome.storage.local.get(null)
    const keys: string[] = []
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(SUBMISSION_PREFIX) && !key.startsWith(EXACT_OUTPUT_PREFIX)) continue
      try {
        const record = key.startsWith(EXACT_OUTPUT_PREFIX)
          ? parseExactOutputSubmission(value)
          : parseStoredSubmission(value)
        if (record.walletId === walletId && record.accountId === accountId) keys.push(key)
      } catch {
        keys.push(key)
      }
    }
    if (keys.length > 0) await chrome.storage.local.remove(keys)
  }

  async clearAll(): Promise<void> {
    for (const area of [chrome.storage.local, chrome.storage.session]) {
      const stored = await area.get(null)
      const keys = Object.keys(stored).filter(
        key => key.startsWith(SUBMISSION_PREFIX) || key.startsWith(EXACT_OUTPUT_PREFIX)
      )
      if (keys.length > 0) await area.remove(keys)
    }
  }

  private key(fingerprint: string): string {
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error('Confidential transfer key is invalid')
    }
    return `${SUBMISSION_PREFIX}${fingerprint}`
  }
}

export interface EvmDAppPrivateTransferCoordinatorOptions {
  readonly analytics?: DAppAnalyticsSink
  readonly network: EvmNetworkConfig
  readonly service: Pick<
    RheaSwapService,
    | 'listTokens'
    | 'quote'
    | 'prepare'
    | 'readEvmTransactionPlan'
    | 'readEvmSignaturePlan'
    | 'recordTransactionSubmission'
    | 'reportSubmission'
    | 'getOrderStatus'
    | 'hasRecordedOrder'
    | 'discard'
  >
  readonly signatureCoordinator: Pick<
    RheaSwapEvmSignatureCoordinator,
    'prepare' | 'confirm' | 'cancel'
  >
  readonly transferController: BackgroundEvmTransferController
  readonly approval: Readonly<{
    requestExternalApproval: (
      origin: string,
      action: string,
      data?: unknown
    ) => Promise<{ readonly approved: boolean; readonly requestId: string }>
  }>
  readonly store?: PrivateTransferSubmissionStore
  readonly exactOutputStore?: ExactOutputSubmissionStore
  readonly pendingSourceStore?: Pick<EvmPendingTransferStore, 'get' | 'getReviewGraph'>
  readonly exactOutputApi?: Pick<
    ConfidentialFundingApi,
    'quoteExactOutput' | 'getOneClickStatus' | 'getStatus'
  >
  readonly readSlippageBps?: () => Promise<number>
  readonly onExactOutputSubmitted?: () => Promise<void>
  readonly now?: () => number
  readonly waitMs?: number
  readonly pollMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

function metadata(input: EvmDAppPrivateTransferInput): Readonly<Record<string, string>> {
  return Object.freeze({
    ...(input.tabInfo.favIconUrl === undefined ? {} : { favicon: input.tabInfo.favIconUrl }),
    ...(input.tabInfo.pageUrl === undefined ? {} : { faviconPageUrl: input.tabInfo.pageUrl })
  })
}

async function fingerprintInput(input: EvmDAppPrivateTransferInput): Promise<string> {
  const value = JSON.stringify({
    origin: input.origin,
    chainId: input.chainId,
    keyDomainId: input.account.keyDomainId,
    accountId: input.account.accountId,
    sender: input.account.address.toLowerCase(),
    assetId: input.intent.assetId,
    recipient: input.intent.recipient.toLowerCase(),
    amountRaw: input.intent.amountRaw
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export class EvmDAppPrivateTransferCoordinator implements EvmDAppPrivateTransferPort {
  private readonly store: PrivateTransferSubmissionStore
  private readonly exactOutputStore: ExactOutputSubmissionStore
  private pendingSourceStore?: Pick<EvmPendingTransferStore, 'get' | 'getReviewGraph'>
  private exactOutputApi?: Pick<
    ConfidentialFundingApi,
    'quoteExactOutput' | 'getOneClickStatus' | 'getStatus'
  >
  private readonly now: () => number
  private readonly waitMs: number
  private readonly pollMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly inFlight = new Map<string, Promise<string>>()
  private readonly exactPreparations = new Map<string, Promise<EvmDAppPrivateTransferPreparation>>()
  private readonly exactExecutions = new Map<string, Promise<string>>()

  constructor(private readonly options: EvmDAppPrivateTransferCoordinatorOptions) {
    this.store = options.store ?? new ChromeEvmDAppPrivateTransferStore()
    this.exactOutputStore = options.exactOutputStore ?? new ChromeEvmDAppExactOutputStore()
    this.pendingSourceStore = options.pendingSourceStore
    this.exactOutputApi = options.exactOutputApi
    this.now = options.now ?? Date.now
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  async send(input: EvmDAppPrivateTransferInput): Promise<string> {
    const fingerprint = await fingerprintInput(input)
    const existing = this.inFlight.get(fingerprint)
    if (existing) return existing
    const operation = this.sendExclusive(input, fingerprint).finally(() => {
      if (this.inFlight.get(fingerprint) === operation) this.inFlight.delete(fingerprint)
    })
    this.inFlight.set(fingerprint, operation)
    return operation
  }

  async resumePending(input: EvmDAppPrivateTransferInput): Promise<string | null> {
    const fingerprint = await fingerprintInput(input)
    const active = this.exactExecutions.get(fingerprint)
    if (active) return active
    const legacyActive = this.inFlight.get(fingerprint)
    if (legacyActive) return legacyActive
    const { legacy, exact: stored } = await this.pendingSubmissions(fingerprint)
    if (legacy) return this.send(input)
    if (!stored) return null
    this.assertExactOutputScope(stored, input)
    if (stored.destinationHash) return stored.destinationHash
    if (await this.clearDefinitelyUnsentExactOutput(stored)) return null
    return this.waitForExactOutput(stored)
  }

  private async clearDefinitelyUnsentExactOutput(stored: ExactOutputSubmission): Promise<boolean> {
    const pendingStore =
      this.pendingSourceStore ??
      (this.pendingSourceStore = new ChromeSessionEvmPendingTransferStore())
    const transactionId = parseTransactionId(stored.transactionId)
    const pending = await pendingStore.get(transactionId).catch(() => null)
    if (
      pending?.phase !== 'awaiting-approval' ||
      pending.scope.keyDomainId !== stored.walletId ||
      pending.scope.accountId !== stored.accountId
    ) {
      return false
    }
    const graph = await pendingStore.getReviewGraph(transactionId).catch(() => null)
    if (
      !graph ||
      graph.root.id !== transactionId ||
      (graph.root.status !== 'prepared' && graph.root.status !== 'approved') ||
      graph.segments.some(segment => segment.evidence?.transactionHash)
    ) {
      return false
    }
    await this.options.transferController.reject(transactionId)
    await this.exactOutputStore.delete(stored.fingerprint)
    return true
  }

  private requireExactOutputApi(): Pick<
    ConfidentialFundingApi,
    'quoteExactOutput' | 'getOneClickStatus' | 'getStatus'
  > {
    if (this.exactOutputApi) return this.exactOutputApi
    const config = getConfidentialFundingNetworkConfig(this.options.network.networkMode)
    if (!config) throw new Error('Confidential exact-output transfers require mainnet')
    this.exactOutputApi = new ConfidentialFundingApi(config, '', __RHEA_SWAP_ACCESS_TOKEN__)
    return this.exactOutputApi
  }

  private async pendingSubmissions(fingerprint: string): Promise<{
    readonly legacy: StoredSubmission | null
    readonly exact: ExactOutputSubmission | null
  }> {
    const [legacy, exact] = await Promise.all([
      this.store.get(fingerprint),
      this.exactOutputStore.get(fingerprint)
    ])
    await Promise.all([
      ...(legacy?.destinationHash ? [this.store.delete(fingerprint)] : []),
      ...(exact?.destinationHash ? [this.exactOutputStore.delete(fingerprint)] : [])
    ])
    return {
      legacy: legacy?.destinationHash ? null : legacy,
      exact: exact?.destinationHash ? null : exact
    }
  }

  async prepareExactOutput(
    input: EvmDAppPrivateTransferInput
  ): Promise<EvmDAppPrivateTransferPreparation> {
    const fingerprint = await fingerprintInput(input)
    const existing = this.exactPreparations.get(fingerprint)
    if (existing) return existing
    const operation = this.prepareExactOutputOnce(input, fingerprint).catch(error => {
      this.exactPreparations.delete(fingerprint)
      throw error
    })
    this.exactPreparations.set(fingerprint, operation)
    return operation
  }

  private async prepareExactOutputOnce(
    input: EvmDAppPrivateTransferInput,
    fingerprint: string
  ): Promise<EvmDAppPrivateTransferPreparation> {
    if (
      input.chainId !== this.options.network.chainId ||
      this.options.network.networkMode !== 'mainnet'
    ) {
      throw new Eip1193ProviderError(
        4200,
        'Confidential transfers are unavailable on this network.'
      )
    }
    const expectedAssetId = input.tokenContract
      ? `${input.chainId}/erc20:${input.tokenContract.toLowerCase()}`
      : `${input.chainId}/slip44:${this.options.network.nativeCurrency.slip44Reference}`
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(input.account.address) ||
      !/^0x[0-9a-fA-F]{40}$/.test(input.intent.recipient) ||
      (input.tokenContract !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(input.tokenContract)) ||
      input.intent.assetId.toLowerCase() !== expectedAssetId.toLowerCase() ||
      !/^[1-9][0-9]{0,77}$/.test(input.intent.amountRaw)
    ) {
      throw new Error('Confidential transfer source, destination, or amount is invalid')
    }
    const pending = await this.pendingSubmissions(fingerprint)
    if (pending.legacy || pending.exact) {
      throw new Eip1193ProviderError(
        -32000,
        'A previous Private transfer is still recorded. Check its result before sending again.'
      )
    }
    await input.ensureIdentity()
    const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(
      candidate => candidate.apiChainId === String(this.options.network.numericChainId)
    )
    if (!descriptor)
      throw new Eip1193ProviderError(4200, 'Confidential transfer route is unavailable.')
    const catalog = await this.options.service.listTokens({
      direction: 'from',
      tokenListChainIds: [descriptor.tokenListChainId]
    })
    const token = resolveRheaPrivateTransferToken(catalog.tokens, input.tokenContract ?? null)
    if (!token || token.assetId === undefined) {
      throw new Eip1193ProviderError(
        4200,
        'This asset is not supported by the Confidential transfer route.'
      )
    }
    const requestedSlippage = this.options.readSlippageBps
      ? await this.options.readSlippageBps().catch(() => undefined)
      : undefined
    const slippageBps =
      Number.isSafeInteger(requestedSlippage) &&
      requestedSlippage! >= 0 &&
      requestedSlippage! <= 5_000
        ? requestedSlippage!
        : DEFAULT_SLIPPAGE_BPS
    const quote = await this.requireExactOutputApi().quoteExactOutput({
      asset: token.assetId,
      amountOutRaw: input.intent.amountRaw,
      sender: input.account.address,
      recipient: input.intent.recipient,
      slippageBps
    })
    const amountIn = BigInt(quote.quote.amountIn)
    const amountOut = BigInt(input.intent.amountRaw)
    if (
      amountIn < BigInt(quote.minimumInputRaw) ||
      amountIn < amountOut ||
      quote.quote.amountOut !== input.intent.amountRaw ||
      quote.quote.minAmountOut !== input.intent.amountRaw
    ) {
      throw new Error('Confidential exact-output quote exceeds the permitted source amount')
    }
    const expiresAt = quote.expiresAt
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
      throw new Error('Confidential exact-output quote has expired')
    }
    const binding = parseNearIntentsTransactionBinding({
      schemaVersion: 1,
      provider: 'near-intents',
      kind: 'swap',
      userAction: 'transfer',
      depositAddress: quote.quote.depositAddress,
      refundAddress: input.account.address,
      expiresAt,
      origin: {
        chainId: input.chainId,
        assetId: input.intent.assetId,
        protocolAssetId: token.assetId
      },
      destination: {
        chainId: input.chainId,
        assetId: input.intent.assetId,
        protocolAssetId: token.assetId,
        recipient: input.intent.recipient,
        expectedAmountRaw: input.intent.amountRaw,
        minimumAmountRaw: input.intent.amountRaw
      }
    })
    const executionAccount: PeaEvmExecutionAccount = Object.freeze({
      kind: 'pea',
      address: input.account.address,
      addressIndex: input.account.addressIndex
    })
    await input.ensureIdentity()
    const prepared = await this.options.transferController.prepare(
      {
        assetId: input.intent.assetId,
        recipient: quote.quote.depositAddress,
        amountRaw: quote.quote.amountIn
      },
      binding,
      undefined,
      'main',
      executionAccount
    )
    const networkFeeRaw = prepared.graph.root.intent?.feeLimit?.amountRaw
    if (!networkFeeRaw || !/^\d+$/.test(networkFeeRaw)) {
      await this.options.transferController.reject(prepared.graph.root.id).catch(() => {})
      throw new Error('Confidential source network fee is unavailable')
    }
    const reviewExpiresAt = Math.min(expiresAt, prepared.review.expiresAt)
    const transactionId = prepared.graph.root.id
    if (reviewExpiresAt <= this.now()) {
      await this.options.transferController.reject(transactionId).catch(() => {})
      throw new Error('Confidential source review has expired')
    }
    let cancelled = false
    let executionStarted = false
    let executePromise: Promise<string> | null = null
    const preparation: EvmDAppPrivateTransferPreparation = {
      approvalData: Object.freeze({
        chainId: this.options.network.numericChainId,
        chainName: this.options.network.displayName,
        iconChain: this.options.network.iconChain,
        sourceAddress: input.account.address,
        recipient: input.intent.recipient,
        asset: Object.freeze({ symbol: token.symbol, decimals: token.decimals }),
        amountRaw: quote.quote.amountIn,
        estimatedOutputRaw: input.intent.amountRaw,
        minimumOutputRaw: input.intent.amountRaw,
        router: 'nearintents',
        expiresAt: reviewExpiresAt,
        approvalRequired: false,
        exactOutput: true,
        networkFeeRaw,
        nativeCurrency: Object.freeze({
          symbol: this.options.network.nativeCurrency.symbol,
          decimals: this.options.network.nativeCurrency.decimals
        }),
        ...metadata(input)
      }),
      execute: () => {
        if (cancelled)
          return Promise.reject(new Eip1193ProviderError(4001, 'Transfer was rejected.'))
        if (executePromise) return executePromise
        executePromise = (async () => {
          await input.ensureIdentity()
          if (cancelled) throw new Eip1193ProviderError(4001, 'Transfer was rejected.')
          if (this.now() >= reviewExpiresAt) throw new Error('Confidential quote has expired')
          const stored = parseExactOutputSubmission({
            schemaVersion: 2,
            fingerprint,
            depositAddress: quote.quote.depositAddress,
            destinationAmountRaw: input.intent.amountRaw,
            sourceAmountRaw: quote.quote.amountIn,
            destinationHash: null,
            transactionId,
            walletId: input.account.keyDomainId,
            accountId: input.account.accountId,
            networkMode: this.options.network.networkMode,
            chainId: input.chainId,
            expiresAt: this.now() + SUBMISSION_CACHE_MS
          })
          await this.exactOutputStore.put(stored)
          if (cancelled) {
            await this.exactOutputStore.delete(fingerprint)
            throw new Eip1193ProviderError(4001, 'Transfer was rejected.')
          }
          executionStarted = true
          let submitted: Awaited<ReturnType<BackgroundEvmTransferController['approveForDApp']>>
          try {
            submitted = await this.options.transferController.approveForDApp(
              transactionId,
              prepared.review.payloadFingerprint.digestHex,
              async () => {
                await input.ensureIdentity()
                if (cancelled) throw new Eip1193ProviderError(4001, 'Transfer was rejected.')
                if (this.now() >= reviewExpiresAt) throw new Error('Confidential quote has expired')
              }
            )
          } catch (error) {
            await this.clearDefinitelyUnsentExactOutput(stored).catch(() => false)
            throw error
          }
          const sourceHash = submitted.graph.segments.find(segment => segment.role === 'origin')
            ?.evidence?.transactionHash
          if (!sourceHash) throw new Error('Confidential transfer source hash is unavailable')
          await this.options.onExactOutputSubmitted?.().catch(() => {})
          return this.waitForExactOutput(stored)
        })().finally(() => {
          this.exactPreparations.delete(fingerprint)
          this.exactExecutions.delete(fingerprint)
          if (!executionStarted) {
            void this.options.transferController.reject(transactionId).catch(() => {})
          }
        })
        this.exactExecutions.set(fingerprint, executePromise)
        return executePromise
      },
      cancel: async () => {
        if (executionStarted || cancelled) return
        cancelled = true
        this.exactPreparations.delete(fingerprint)
        await this.options.transferController.reject(transactionId)
      }
    }
    return preparation
  }

  private assertExactOutputScope(
    stored: ExactOutputSubmission,
    input: EvmDAppPrivateTransferInput
  ): void {
    if (
      stored.walletId !== input.account.keyDomainId ||
      stored.accountId !== input.account.accountId ||
      stored.networkMode !== this.options.network.networkMode ||
      stored.chainId !== input.chainId ||
      stored.destinationAmountRaw !== input.intent.amountRaw
    ) {
      throw new Error('Confidential exact-output transfer account changed')
    }
  }

  private async waitForExactOutput(stored: ExactOutputSubmission): Promise<string> {
    const deadline = this.now() + this.waitMs
    while (this.now() < deadline) {
      const status = await this.requireExactOutputApi()
        .getOneClickStatus(stored.depositAddress)
        .catch(() => null)
      const normalized = status?.status.trim().toUpperCase()
      if (normalized === 'SUCCESS' || normalized === 'COMPLETED') {
        if (status?.settledAmountOutRaw !== stored.destinationAmountRaw) {
          throw new Eip1193ProviderError(
            -32000,
            'Confidential settlement amount could not be verified. Check Wallet Activity.'
          )
        }
        const hash =
          status.transactionHash ??
          (
            await this.requireExactOutputApi()
              .getStatus(stored.depositAddress, String(this.options.network.numericChainId))
              .catch(() => null)
          )?.transactionHash
        if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
          throw new Eip1193ProviderError(-32000, 'Confidential destination hash is unavailable.')
        }
        await this.exactOutputStore.put(
          parseExactOutputSubmission({
            ...stored,
            destinationHash: hash.toLowerCase(),
            expiresAt: this.now() + COMPLETED_CACHE_MS
          })
        )
        return hash.toLowerCase()
      }
      if (normalized && ['FAILED', 'REFUNDED', 'EXPIRED', 'CANCELLED'].includes(normalized)) {
        await this.exactOutputStore.delete(stored.fingerprint)
        throw new Eip1193ProviderError(
          -32000,
          `The Confidential transfer ${normalized.toLowerCase()}.`
        )
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())))
    }
    throw new Eip1193ProviderError(
      -32000,
      'The Confidential transfer is still processing. Check Wallet Activity for its final status.'
    )
  }

  private async sendExclusive(
    input: EvmDAppPrivateTransferInput,
    fingerprint: string
  ): Promise<string> {
    const stored = await this.store.get(fingerprint)
    if (stored) {
      if (
        stored.walletId !== undefined &&
        (stored.walletId !== input.account.keyDomainId ||
          stored.accountId !== input.account.accountId ||
          stored.networkMode !== this.options.network.networkMode)
      ) {
        throw new Error('Confidential dApp transfer account changed')
      }
      if (stored.destinationHash) return stored.destinationHash
      const scopedStored = stored.walletId
        ? stored
        : parseStoredSubmission({
            ...stored,
            walletId: input.account.keyDomainId,
            accountId: input.account.accountId,
            networkMode: this.options.network.networkMode
          })
      if (!stored.walletId) await this.store.put(scopedStored)
      const hasRecordedOrder = await this.options.service
        .hasRecordedOrder(scopedStored.quoteHandle)
        .catch(() => false)
      if (!hasRecordedOrder) {
        throw new Eip1193ProviderError(
          -32000,
          'The previous Confidential transfer status is unknown. No new transfer was started. Check its result before sending again.'
        )
      }
      return this.waitForDestination(scopedStored)
    }

    const exactSubmission = await this.exactOutputStore.get(fingerprint)
    if (exactSubmission) {
      this.assertExactOutputScope(exactSubmission, input)
      const active = this.exactExecutions.get(fingerprint)
      if (active) return active
      if (
        !exactSubmission.destinationHash &&
        (await this.clearDefinitelyUnsentExactOutput(exactSubmission))
      ) {
        throw new Eip1193ProviderError(
          -32000,
          'The prior Private transfer was not sent. Review a new request.'
        )
      }
      return exactSubmission.destinationHash ?? this.waitForExactOutput(exactSubmission)
    }

    const descriptor = RHEA_SWAP_CHAIN_CATALOG.find(
      candidate => candidate.apiChainId === String(this.options.network.numericChainId)
    )
    if (!descriptor) {
      throw new Eip1193ProviderError(
        4200,
        'Confidential transfers are unavailable on this network.'
      )
    }
    const catalog = await this.options.service.listTokens({
      direction: 'from',
      tokenListChainIds: [descriptor.tokenListChainId]
    })
    const token = resolveRheaPrivateTransferToken(catalog.tokens, input.tokenContract ?? null)
    if (!token) {
      throw new Eip1193ProviderError(
        4200,
        'This asset is not supported by the Confidential transfer route.'
      )
    }
    const requestedSlippage = this.options.readSlippageBps
      ? await this.options.readSlippageBps().catch(() => undefined)
      : undefined
    const slippageBps =
      Number.isSafeInteger(requestedSlippage) &&
      requestedSlippage! >= 0 &&
      requestedSlippage! <= 5_000
        ? requestedSlippage!
        : DEFAULT_SLIPPAGE_BPS
    const quote = await this.options.service.quote(
      {
        fromChain: token.rheaChainId,
        toChain: token.rheaChainId,
        tokenIn: { chain: token.rheaChainId, address: token.rheaAddress },
        tokenOut: { chain: token.rheaChainId, address: token.rheaAddress },
        amountIn: input.intent.amountRaw,
        slippageBps,
        sender: input.account.address,
        recipient: input.intent.recipient,
        confidentiality: 'basic'
      },
      undefined,
      {
        walletId: input.account.keyDomainId,
        accountId: input.account.accountId,
        purpose: 'private-dapp-transfer'
      }
    )
    const review = await this.options.service.prepare(quote.quoteHandle)
    if (review.execution.kind !== 'evm-signature' && review.execution.kind !== 'evm-transaction') {
      await this.options.service.discard(quote.quoteHandle).catch(() => {})
      throw new Eip1193ProviderError(
        4200,
        'The Confidential route cannot be signed by this wallet.'
      )
    }
    const sourceTarget =
      review.execution.kind === 'evm-signature' ? input.account.address : review.execution.target
    if (!sourceTarget) throw new Error('Confidential transfer route has no source target')
    const binding = parseRheaSwapTransactionBinding({
      schemaVersion: 1,
      provider: 'rhea-cross-chain-dex',
      kind: 'swap',
      userAction: 'transfer',
      quoteHandle: quote.quoteHandle,
      executionId: review.executionId,
      router: review.router,
      sourceTarget,
      sender: input.account.address,
      originAmountRaw: review.amountIn,
      expiresAt: quote.expiresAt ?? quote.receivedAt + 30_000,
      // Confidential settlement crosses the Intents boundary even for same-chain assets.
      isCrossChain: true,
      origin: {
        chainId: input.chainId,
        assetId: input.intent.assetId,
        protocolChainId: token.rheaChainId,
        protocolAssetId: token.assetId
      },
      destination: {
        chainId: input.chainId,
        assetId: input.intent.assetId,
        protocolChainId: token.rheaChainId,
        protocolAssetId: token.assetId,
        recipient: input.intent.recipient,
        expectedAmountRaw: quote.estimatedOut,
        minimumAmountRaw: quote.minAmountOut
      }
    })
    const executionAccount: PeaEvmExecutionAccount = Object.freeze({
      kind: 'pea',
      address: input.account.address,
      addressIndex: input.account.addressIndex
    })

    let approvalPrepared: Awaited<
      ReturnType<BackgroundEvmTransferController['prepareContractCall']>
    > | null = null
    let routePrepared: Awaited<
      ReturnType<BackgroundEvmTransferController['prepareContractCall']>
    > | null = null
    let signatureReview: Awaited<ReturnType<RheaSwapEvmSignatureCoordinator['prepare']>> | null =
      null
    let executionStarted = false
    try {
      const plan =
        review.execution.kind === 'evm-transaction'
          ? await this.options.service.readEvmTransactionPlan(quote.quoteHandle)
          : null
      const signaturePlan =
        review.execution.kind === 'evm-signature'
          ? await this.options.service.readEvmSignaturePlan(quote.quoteHandle)
          : null
      const approvalCall = plan?.approval ?? signaturePlan?.approval ?? null
      if (approvalCall) {
        approvalPrepared = await this.options.transferController.prepareContractCall(
          {
            chainId: input.chainId,
            contractAddress: approvalCall.transaction.to,
            valueRaw: approvalCall.transaction.value,
            calldata: approvalCall.transaction.data
          },
          undefined,
          undefined,
          executionAccount
        )
      }
      if (plan && !approvalCall) {
        routePrepared = await this.options.transferController.prepareContractCall(
          {
            chainId: input.chainId,
            contractAddress: plan.transaction.to,
            valueRaw: plan.transaction.value,
            calldata: plan.transaction.data
          },
          undefined,
          binding,
          executionAccount
        )
      }
      if (signaturePlan && !approvalCall) {
        signatureReview = await this.options.signatureCoordinator.prepare(
          quote.quoteHandle,
          binding,
          'private'
        )
      }
      const decision = await this.options.approval.requestExternalApproval(
        input.origin,
        'evmPrivateTransfer',
        {
          chainId: this.options.network.numericChainId,
          chainName: this.options.network.displayName,
          iconChain: this.options.network.iconChain,
          sourceAddress: input.account.address,
          recipient: input.intent.recipient,
          asset: { symbol: token.symbol, decimals: token.decimals },
          amountRaw: input.intent.amountRaw,
          estimatedOutputRaw: quote.estimatedOut,
          minimumOutputRaw: quote.minAmountOut,
          router: review.router,
          expiresAt: binding.expiresAt,
          approvalRequired: approvalPrepared !== null,
          ...metadata(input)
        }
      )
      if (!decision.approved) {
        throw new Eip1193ProviderError(4001, 'User rejected the Confidential transfer request.')
      }
      await input.ensureIdentity()
      if (approvalPrepared) {
        await this.options.transferController.approveForDApp(
          approvalPrepared.graph.root.id,
          approvalPrepared.review.payloadFingerprint.digestHex,
          async () => input.ensureIdentity()
        )
        approvalPrepared = null
        await input.ensureIdentity()
        if (plan) {
          routePrepared = await this.options.transferController.prepareContractCall(
            {
              chainId: input.chainId,
              contractAddress: plan.transaction.to,
              valueRaw: plan.transaction.value,
              calldata: plan.transaction.data
            },
            undefined,
            binding,
            executionAccount
          )
        } else if (signaturePlan) {
          signatureReview = await this.options.signatureCoordinator.prepare(
            quote.quoteHandle,
            binding,
            'private'
          )
        }
      }
      await input.ensureIdentity()
      const storedSubmission = parseStoredSubmission({
        schemaVersion: 1,
        fingerprint,
        quoteHandle: quote.quoteHandle,
        destinationHash: null,
        expiresAt: this.now() + SUBMISSION_CACHE_MS,
        walletId: input.account.keyDomainId,
        accountId: input.account.accountId,
        networkMode: this.options.network.networkMode
      })
      // Token approval cannot debit the transfer amount. Preserve the request
      // only when route signing or broadcast may begin.
      await this.store.put(storedSubmission)
      executionStarted = true
      let submission: RheaSwapSubmissionView
      if (signatureReview) {
        const result = await this.options.signatureCoordinator.confirm(
          signatureReview.quoteHandle,
          signatureReview.payloadFingerprint
        )
        submission = result.submission
        signatureReview = null
      } else if (routePrepared) {
        const result = await this.options.transferController.approveForDApp(
          routePrepared.graph.root.id,
          routePrepared.review.payloadFingerprint.digestHex,
          async () => input.ensureIdentity()
        )
        routePrepared = null
        const sourceHash = result.graph.segments.find(segment => segment.role === 'origin')
          ?.evidence?.transactionHash
        if (!sourceHash) throw new Error('Confidential transfer source hash is unavailable')
        submission = await this.options.service.recordTransactionSubmission(
          quote.quoteHandle,
          sourceHash
        )
        await this.options.service.reportSubmission(quote.quoteHandle).catch(() => {})
      } else {
        throw new Error('Confidential transfer execution is unavailable')
      }
      if (!submission.orderId) throw new Error('Confidential transfer has no settlement order')
      return this.waitForDestination(storedSubmission)
    } finally {
      // Once route signing or broadcast can have started, retain the
      // fingerprint. A retry must observe the same order after an ambiguous
      // extension-worker or provider response.
      if (!executionStarted) {
        await this.store.delete(fingerprint).catch(() => {})
        if (approvalPrepared) {
          await this.options.transferController
            .reject(approvalPrepared.graph.root.id)
            .catch(() => {})
        }
        if (routePrepared) {
          await this.options.transferController.reject(routePrepared.graph.root.id).catch(() => {})
        }
        if (signatureReview) {
          await this.options.signatureCoordinator
            .cancel(signatureReview.quoteHandle)
            .catch(() => {})
        }
        await this.options.service.discard(quote.quoteHandle).catch(() => {})
      }
    }
  }

  private async waitForDestination(submission: StoredSubmission): Promise<string> {
    const deadline = this.now() + this.waitMs
    while (this.now() < deadline) {
      const status = await this.options.service
        .getOrderStatus(submission.quoteHandle)
        .catch(() => null)
      if (status?.destinationHash && status.status === 'completed') {
        const completed = parseStoredSubmission({
          ...submission,
          destinationHash: status.destinationHash,
          expiresAt: this.now() + COMPLETED_CACHE_MS
        })
        await this.store.put(completed)
        return status.destinationHash
      }
      if (
        status &&
        (status.status === 'failed' || status.status === 'refunded' || status.status === 'expired')
      ) {
        emitDAppEvent(this.options.analytics, 'evm', ANALYTICS_EVENTS.DAPP_TRANSACTION_FAILED, {
          hasTransaction: 1,
          idempotencyKey: `dapp:evm:private-failed:${submission.quoteHandle}`,
          extra: { funding_source: 'private' }
        })
        await this.store.delete(submission.fingerprint)
        throw new Eip1193ProviderError(
          -32000,
          `The Confidential transfer ${status.status}. Check Wallet Activity for details.`
        )
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())))
    }
    throw new Eip1193ProviderError(
      -32000,
      'The Confidential transfer was submitted and is still processing. Check Wallet Activity for its final status.'
    )
  }
}
