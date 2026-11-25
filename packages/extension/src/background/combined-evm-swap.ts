import { parseTransactionId, parseRheaSwapTransactionBinding } from '@/core/transactions/domain'
import type {
  RheaSwapTransactionBinding,
  TransactionAccountScope,
  TransactionGraph
} from '@/core/transactions/domain'
import type { RheaSwapService } from '@/core/services/rhea-swap'
import type { SigningSummary } from '@/core/keyring/domain'
import { getRheaSwapQuoteDeadline } from '@/core/services/rhea-swap/rhea-swap-quote-validity'
import {
  canContinueCombinedSwap,
  getCombinedSwapFeeLimit
} from '@/core/services/rhea-swap/combined-swap-review'
import {
  EvmTransactionError,
  parseEvmFeeSelection,
  type EvmFeeSelection
} from '@/infrastructure/chains/evm'
import type { BackgroundEvmTransferRouter } from './evm-transfer-router'
import type { EvmTransferExecutionMode } from './evm-transfer-controller'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'

export const COMBINED_EVM_SWAP_ALARM = 'combined-evm-swap'
const PREFIX = 'combined_evm_swap:'
const RETAIN_MS = 24 * 60 * 60_000
const ALLOWANCE_WAIT_MS = 60_000

export type CombinedEvmSwapProgress = {
  readonly approvalId: string
  readonly approvalHash?: string
} & (
  | { readonly status: 'approving' | 'submitting'; readonly message?: string }
  | { readonly status: 'approval-failed' | 'review-required'; readonly message: string }
  | { readonly status: 'broadcast'; readonly swapId: string; readonly swapHash: string }
)

export interface CombinedEvmSwapInput {
  readonly approvalId: string
  readonly approvalFingerprint: string
  readonly binding: RheaSwapTransactionBinding
  readonly executionMode?: EvmTransferExecutionMode
  readonly feeBudgetWei: string
  readonly feeSelection: EvmFeeSelection
}

interface AccountContext {
  readonly network: string
  readonly walletId: string | null
  readonly accountId: string | null
  readonly unlockEpoch: string | null
}

interface RecordEntry {
  readonly scope: TransactionAccountScope
  readonly network: string
  readonly unlockEpoch: string
  readonly input: CombinedEvmSwapInput
  readonly feeLimit: { readonly maxFeePerGasWei: string; readonly swapFeeWei: string }
  readonly createdAt: number
  readonly confirmedAt?: number
  readonly swap?: { readonly id: string; readonly fingerprint: string }
  readonly progress: CombinedEvmSwapProgress
}

interface Options {
  readonly router: () => BackgroundEvmTransferRouter | null
  readonly quote: RheaSwapService | null
  readonly readAccount: () => Promise<AccountContext>
  readonly readGraph: (
    scope: TransactionAccountScope,
    id: string
  ) => Promise<TransactionGraph | null>
  readonly validateQuote: (
    binding: RheaSwapTransactionBinding,
    executionMode: EvmTransferExecutionMode
  ) => Promise<void>
  readonly checkApproval: (scope: TransactionAccountScope, chainId: string) => Promise<void>
  readonly schedule: () => Promise<void>
}

function parseInput(value: unknown): CombinedEvmSwapInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid Swap review')
  const input = value as Partial<CombinedEvmSwapInput>
  if (
    typeof input.approvalFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.approvalFingerprint) ||
    typeof input.feeBudgetWei !== 'string' ||
    !/^[1-9][0-9]{0,77}$/.test(input.feeBudgetWei) ||
    (input.executionMode !== undefined &&
      input.executionMode !== 'main' &&
      input.executionMode !== 'private')
  )
    throw new Error('Invalid Swap review')
  return {
    approvalId: parseTransactionId(input.approvalId),
    approvalFingerprint: input.approvalFingerprint,
    binding: parseRheaSwapTransactionBinding(input.binding),
    executionMode: input.executionMode ?? 'main',
    feeBudgetWei: input.feeBudgetWei,
    feeSelection: parseEvmFeeSelection(input.feeSelection)
  }
}

function origin(graph: TransactionGraph | null) {
  return graph?.segments.find(segment => segment.role === 'origin')
}

function matchesAccount(
  record: Pick<RecordEntry, 'network' | 'scope'>,
  account: AccountContext
): boolean {
  return (
    record.network === account.network &&
    record.scope.keyDomainId === account.walletId &&
    record.scope.accountId === account.accountId
  )
}

function isPending(progress: CombinedEvmSwapProgress): boolean {
  return progress.status === 'approving' || progress.status === 'submitting'
}

export class CombinedEvmSwap {
  private readonly queue = new SerialTaskQueue()
  private readonly polling = new DedupPromise<void>()
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: Options) {}

  start(value: unknown): Promise<CombinedEvmSwapProgress> {
    return this.queue.run(async () => {
      const input = parseInput(value)
      const existing = await this.read(input.approvalId)
      if (existing) {
        if (!matchesAccount(existing, await this.options.readAccount()))
          throw new Error('Active account changed')
        return existing.progress
      }
      const router = this.options.router()
      if (!router) throw new Error('EVM transfer is unavailable')
      const account = await this.options.readAccount()
      const pending = await router.getPendingApproval(input.approvalId)
      if (
        !account.unlockEpoch ||
        !pending ||
        pending.graph.root.kind !== 'approve' ||
        pending.review.payloadFingerprint.digestHex !== input.approvalFingerprint
      ) {
        throw new Error('Token approval needs to be reviewed again')
      }
      const draft = {
        scope: pending.graph.root.scope,
        network: account.network,
        unlockEpoch: account.unlockEpoch,
        input,
        createdAt: Date.now(),
        progress: { status: 'approving' as const, approvalId: input.approvalId }
      }
      if (!matchesAccount(draft, account)) throw new Error('Active account changed')
      const feeLimit = await this.readReviewedPlan(input, pending.review.summary)
      const record = { ...draft, feeLimit }
      await this.options.schedule()
      await this.write(record)
      const next = await this.advance(record)
      if (isPending(next.progress)) this.pollSoon()
      return next.progress
    })
  }

  async get(id: string): Promise<CombinedEvmSwapProgress | null> {
    const entry = await this.read(parseTransactionId(id))
    return entry && matchesAccount(entry, await this.options.readAccount()) ? entry.progress : null
  }

  poll(): Promise<void> {
    return this.polling.run(() =>
      this.queue.run(async () => {
        const records = await chrome.storage.session.get(null)
        let pending = false
        let recent = false
        for (const [key, value] of Object.entries(records)) {
          if (!key.startsWith(PREFIX)) continue
          const record = value as RecordEntry
          if (Date.now() - record.createdAt > RETAIN_MS) {
            await chrome.storage.session.remove(key)
          } else if (isPending(record.progress)) {
            const next = await this.advance(record).catch(() => record)
            if (isPending(next.progress)) {
              pending = true
              recent ||= Date.now() - next.createdAt < 30_000
            }
          }
        }
        if (pending) await this.options.schedule()
        if (recent) this.pollSoon()
      })
    )
  }

  private pollSoon(): void {
    if (this.retryTimer !== undefined) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.poll().catch(() => {})
    }, 3_000)
  }

  private async read(id: string): Promise<RecordEntry | undefined> {
    const key = PREFIX + id
    return (await chrome.storage.session.get(key))[key] as RecordEntry | undefined
  }

  private async write(record: RecordEntry): Promise<RecordEntry> {
    await chrome.storage.session.set({ [PREFIX + record.input.approvalId]: record })
    return record
  }

  private update(record: RecordEntry, progress: CombinedEvmSwapProgress): Promise<RecordEntry> {
    return this.write({ ...record, progress })
  }

  private async readReviewedPlan(input: CombinedEvmSwapInput, summary: SigningSummary) {
    const { quote } = this.options
    if (!quote || summary.schema !== 'evm.transaction.v1')
      throw new Error('Swap review is unavailable')
    const view = await quote.readQuoteView(input.binding.quoteHandle)
    const build = await quote.readPreparedBuild(input.binding.quoteHandle)
    const plan = await quote.readEvmTransactionPlan(input.binding.quoteHandle)
    const expected = plan.approval?.transaction
    if (
      !expected ||
      plan.executionId !== input.binding.executionId ||
      getRheaSwapQuoteDeadline(view) !== input.binding.expiresAt ||
      input.binding.origin.chainId !== summary.chainId ||
      input.binding.originAmountRaw !== build.amountIn ||
      summary.fields.maximumFeeWei === '0' ||
      summary.fields.from.toLowerCase() !== input.binding.sender.toLowerCase() ||
      summary.chainId !== `eip155:${expected.chainId}` ||
      summary.fields.to?.toLowerCase() !== expected.to.toLowerCase() ||
      summary.fields.calldata.encoding !== 'hex' ||
      summary.fields.calldata.value.toLowerCase() !== expected.data.toLowerCase() ||
      summary.fields.valueWei !== expected.value ||
      build.minAmountOut !== input.binding.destination.minimumAmountRaw ||
      build.estimatedOut !== input.binding.destination.expectedAmountRaw ||
      plan.transaction.to.toLowerCase() !== input.binding.sourceTarget.toLowerCase()
    ) {
      throw new Error('Token approval does not match the reviewed Swap')
    }
    await this.options.validateQuote(input.binding, input.executionMode ?? 'main')
    const limit = getCombinedSwapFeeLimit(plan.transaction, summary.fields, input.feeBudgetWei)
    if (!limit || limit.approvalFeeWei + limit.swapFeeWei !== BigInt(input.feeBudgetWei)) {
      throw new Error('Swap fee needs to be reviewed again')
    }
    return {
      maxFeePerGasWei: limit.maxFeePerGasWei.toString(),
      swapFeeWei: limit.swapFeeWei.toString()
    }
  }

  private async advance(record: RecordEntry): Promise<RecordEntry> {
    const router = this.options.router()
    const quote = this.options.quote
    if (!router || !quote) return record
    const { input, scope } = record
    const readReviewedGraph = async (id: string, fingerprint: string) => {
      const persisted = await this.options.readGraph(scope, id)
      if (persisted) return persisted
      const pending = await router.getPendingApproval(id)
      return pending?.graph.root.id === id &&
        pending.graph.root.scope.keyDomainId === scope.keyDomainId &&
        pending.graph.root.scope.accountId === scope.accountId &&
        pending.review.payloadFingerprint.digestHex === fingerprint
        ? pending.graph
        : null
    }
    let approval = await readReviewedGraph(input.approvalId, input.approvalFingerprint)
    if (
      approval &&
      ['signed', 'broadcast', 'confirming'].includes(origin(approval)?.status ?? '')
    ) {
      await this.options.checkApproval(scope, input.binding.origin.chainId).catch(() => {})
      approval = await this.options.readGraph(scope, input.approvalId)
    }
    const approvalHash = origin(approval)?.evidence?.transactionHash
    const base = { approvalId: input.approvalId, ...(approvalHash ? { approvalHash } : {}) }
    const review = (message: string) =>
      this.update(record, { ...base, status: 'review-required', message })
    const approvalFailed = () =>
      this.update(record, {
        ...base,
        status: 'approval-failed',
        message: 'Token approval failed. Start a new Swap.'
      })
    const swap = record.swap && (await readReviewedGraph(record.swap.id, record.swap.fingerprint))
    const swapOrigin = origin(swap || null)
    const swapHash = swapOrigin?.evidence?.transactionHash
    if (
      record.swap &&
      swapHash &&
      (swapOrigin.status === 'broadcast' ||
        swapOrigin.status === 'confirming' ||
        swapOrigin.status === 'final' ||
        swapOrigin.evidence?.blockHash)
    ) {
      return this.update(record, { ...base, status: 'broadcast', swapId: record.swap.id, swapHash })
    }
    if (!approval || approval.root.status === 'failed') return approvalFailed()
    const account = await this.options.readAccount()
    const canSign = matchesAccount(record, account) && record.unlockEpoch === account.unlockEpoch
    const authorize = async () => {
      const latest = await this.options.readAccount()
      if (
        !matchesAccount(record, latest) ||
        record.unlockEpoch !== latest.unlockEpoch ||
        input.binding.expiresAt <= Date.now()
      )
        throw new Error('Review the Swap again to continue')
    }
    const expired = input.binding.expiresAt <= Date.now()
    if (approval.root.status !== 'final') {
      if (!approvalHash && (expired || !canSign))
        return review('Review the Swap again to continue.')
      if (canSign) {
        try {
          if (origin(approval)?.status === 'signed') await router.resumeBroadcast(input.approvalId)
          else if (!approvalHash)
            await router.approve(input.approvalId, input.approvalFingerprint, authorize)
        } catch {
          const latest = await this.options.readGraph(scope, input.approvalId)
          if (!origin(latest)?.evidence?.transactionHash) return approvalFailed()
        }
      }
      const latest = origin(await this.options.readGraph(scope, input.approvalId))
      return latest?.evidence?.transactionHash && latest.evidence.transactionHash !== approvalHash
        ? this.update(record, {
            ...base,
            status: 'approving',
            approvalHash: latest.evidence.transactionHash
          })
        : record
    }
    if (record.swap && swapHash && swapOrigin.status === 'signed') {
      if (canSign && !expired) await router.resumeBroadcast(record.swap.id).catch(() => {})
      if (expired && !('message' in record.progress)) {
        return this.update(record, {
          ...base,
          status: 'submitting',
          message: 'Checking whether the Swap was submitted.'
        })
      }
      return record
    }
    if (expired) return review('Token approved. The quote expired. Review a new quote to continue.')
    if (!canSign) return review('Token approved. Review the Swap again to continue.')
    if (!record.confirmedAt) {
      record = await this.write({
        ...record,
        confirmedAt: Date.now(),
        progress: { ...base, status: 'submitting' }
      })
    }
    const plan = await quote.readEvmTransactionPlan(input.binding.quoteHandle).catch(() => null)
    if (!plan?.approval || plan.executionId !== input.binding.executionId)
      return review('Token approved. Review the Swap again to continue.')
    const allowance = await router.getTokenAllowance(
      input.binding.origin.chainId,
      plan.approval.transaction.to,
      plan.approval.spender,
      input.binding.sender,
      input.executionMode ?? 'main'
    )
    if (BigInt(allowance) < BigInt(plan.approval.amountRaw)) {
      return Date.now() - (record.confirmedAt ?? Date.now()) >= ALLOWANCE_WAIT_MS
        ? review(
            'Token approval confirmed, but the allowance is insufficient. Review the Swap again.'
          )
        : record
    }
    if (record.swap) {
      if (!swap || swap.root.status === 'failed')
        return review('Token approved. Review the Swap again to continue.')
      try {
        const submitted = await router.approve(record.swap.id, record.swap.fingerprint, authorize)
        const submittedHash = origin(submitted.graph)?.evidence?.transactionHash
        if (submitted.status === 'broadcast' && submittedHash) {
          return this.update(record, {
            ...base,
            status: 'broadcast',
            swapId: record.swap.id,
            swapHash: submittedHash
          })
        }
      } catch {
        const latest = await this.options.readGraph(scope, record.swap.id)
        if (!origin(latest)?.evidence?.transactionHash) {
          return review(
            input.binding.expiresAt <= Date.now()
              ? 'Token approved. The quote expired. Review a new quote to continue.'
              : 'Token approved. The Swap was not submitted. Review the Swap again.'
          )
        }
      }
      return record
    }
    let prepared: Awaited<ReturnType<BackgroundEvmTransferRouter['prepareContractCall']>>
    try {
      prepared = await router.prepareContractCall(
        {
          chainId: input.binding.origin.chainId,
          contractAddress: plan.transaction.to,
          valueRaw: plan.transaction.value,
          calldata: plan.transaction.data
        },
        input.feeSelection,
        input.binding,
        input.executionMode ?? 'main'
      )
    } catch (error) {
      if (error instanceof EvmTransactionError) {
        if (error.code === 'insufficient-funds') {
          return review('Token approved. Add funds for the network fee, then review again.')
        }
        if (error.code === 'simulation-failed') {
          return review('Token approved. The transaction failed simulation. Review a new quote.')
        }
      }
      throw error
    }
    const { feeLimit } = record
    const summary = prepared.review.summary
    if (
      summary.schema !== 'evm.transaction.v1' ||
      prepared.graph.root.scope.keyDomainId !== scope.keyDomainId ||
      prepared.graph.root.scope.accountId !== scope.accountId ||
      !canContinueCombinedSwap(
        summary,
        {
          approvalFeeWei: 0n,
          swapFeeWei: BigInt(feeLimit.swapFeeWei),
          maxFeePerGasWei: BigInt(feeLimit.maxFeePerGasWei)
        },
        plan.transaction,
        input.binding.sender
      )
    ) {
      await router.reject(prepared.graph.root.id).catch(() => {})
      return review('Token approved. The Swap fee changed. Review the Swap again to continue.')
    }
    const reserved = await this.write({
      ...record,
      swap: {
        id: prepared.graph.root.id,
        fingerprint: prepared.review.payloadFingerprint.digestHex
      }
    })
    return this.advance(reserved)
  }
}
