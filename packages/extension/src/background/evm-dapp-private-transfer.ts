import { ANALYTICS_EVENTS } from '@/lib/analytics/constants'
import { emitDAppEvent, type DAppAnalyticsSink } from './dapp-analytics'
import type { EvmNetworkConfig } from '@/config/networks'
import { Eip1193ProviderError } from '@/core/dapp/eip1193'
import {
  RHEA_SWAP_CHAIN_CATALOG,
  resolveRheaPrivateTransferToken,
  type RheaSwapService,
  type RheaSwapSubmissionView
} from '@/core/services/rhea-swap'
import { parseRheaSwapTransactionBinding } from '@/core/transactions/domain'
import type { EvmTransferIntent, PeaEvmExecutionAccount } from '@/infrastructure/chains/evm'
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
      if (!key.startsWith(SUBMISSION_PREFIX)) continue
      try {
        const record = parseStoredSubmission(value)
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
      const keys = Object.keys(stored).filter(key => key.startsWith(SUBMISSION_PREFIX))
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
  readonly readSlippageBps?: () => Promise<number>
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
  private readonly now: () => number
  private readonly waitMs: number
  private readonly pollMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(private readonly options: EvmDAppPrivateTransferCoordinatorOptions) {
    this.store = options.store ?? new ChromeEvmDAppPrivateTransferStore()
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
