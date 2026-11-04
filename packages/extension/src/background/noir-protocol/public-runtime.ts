import { MARGINAL_FEE_ZATS } from '@/config/fee'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import { requirePublicConfig } from '@/core/services/noir-protocol/public/config'
import {
  assertPublicFeeQuoteStillCovers,
  buildPublicPaidRequests
} from '@/core/services/noir-protocol/public/fee'
import {
  derivePublicIdentity,
  signPublicMessage
} from '@/core/services/noir-protocol/public/identity'
import {
  assertPublicActivationQuoteForPayment,
  createPublicActivationQuoteRequest
} from '@/core/services/noir-protocol/public/activation-quote'
import {
  createPublicCandidate,
  parsePublicFunctionCallRequests,
  parsePublicSigningMessage,
  serializePublicBusiness
} from '@/core/services/noir-protocol/public/protocol'
import type {
  NoirPublicAccount,
  NoirPublicAssets,
  NoirPublicTransaction,
  NoirPublicTransactionParams
} from '@/core/services/noir-protocol/public/types'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import { NoirPublicClient } from '@/infrastructure/noir-protocol/public-client'
import { getPublicActivationQuote } from '@/infrastructure/noir-protocol/public-activation-client'
import {
  NoirPublicTransactionRepository,
  fingerprintPublicRequests,
  type NoirPublicTransactionRecord,
  type NoirPublicActivationRecord
} from '@/infrastructure/noir-protocol/public-transaction-repository'
import { NoirPublicPortfolioCache } from '@/infrastructure/noir-protocol/public-portfolio'
import {
  readPublicAccountProjection,
  writePublicAccountProjection
} from '@/infrastructure/noir-protocol/public-account-projection'
import { DedupPromise, SerialTaskQueue } from '@/lib/async-utils'
import { formatBaseUnitDecimalAmount } from '@/lib/number-format'
import { loadTransactions } from '@/lib/indexed-db'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { buildAccountKey } from '@/store/account-data-store'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { accountContextTransition } from '../account-context-transition'
import {
  assertPublicContext,
  publicTransactionScope,
  type NoirPublicRequestContext
} from './public-context'
import { backgroundZcashWalletRuntime } from '../zcash-wallet-runtime'
import { transactionRecorder } from '../transaction-recorder'

export const PUBLIC_TRANSACTION_MONITOR_ALARM = 'noir-public-monitor'

type NoirPublicApproval = (
  action: 'publicActivate' | 'publicTransaction',
  data: unknown
) => Promise<{ approved: boolean }>

export interface NoirPublicPayment {
  readonly context: NoirPublicRequestContext
  readonly transactionId: string
  readonly depositAddress: string
  readonly amount: string
  readonly expiresAt: number
}

function parseRequest(value: unknown): NoirPublicTransactionParams {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Public transaction')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).length !== 2 ||
    typeof input.requestId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)
  ) {
    throw new Error('Public requestId must be a stable identifier')
  }
  return {
    requestId: input.requestId,
    txRequests: parsePublicFunctionCallRequests(input.txRequests)
  }
}

function clientFor(network: NoirPublicRequestContext['network']): NoirPublicClient {
  return new NoirPublicClient(
    requirePublicConfig(network),
    resolveNearRuntimeNetworkConfig(network).rpcUrl
  )
}

function queueKey(context: NoirPublicRequestContext, publicKey: string): string {
  return JSON.stringify([
    context.network,
    requirePublicConfig(context.network).parentContractId,
    publicKey
  ])
}

let accountChangedListener: (() => void) | null = null

function notifyChanged(context: Pick<NoirPublicRequestContext, 'walletId' | 'accountId'>): void {
  accountChangedListener?.()
  void chrome.runtime
    .sendMessage({
      type: 'PORTFOLIO_UPDATED',
      walletId: context.walletId,
      accountId: context.accountId
    })
    .catch(() => {})
}

export class NoirPublicRuntime {
  setAccountChangedListener(listener: () => void): void {
    accountChangedListener = listener
  }
  private readonly repository = new NoirPublicTransactionRepository(
    new IndexedDbTransactionRepository()
  )
  private readonly portfolio = new NoirPublicPortfolioCache()
  private readonly queues = new Map<string, { queue: SerialTaskQueue; count: number }>()
  private readonly monitor = new DedupPromise<void>()
  private readonly accountRefreshes = new Map<string, Promise<NoirPublicAccount>>()
  private paymentExecutor: ((payment: NoirPublicPayment) => Promise<void>) | null = null
  private identityReadiness: (() => Promise<boolean>) | null = null

  setIdentityReadiness(ready: () => Promise<boolean>): void {
    this.identityReadiness = ready
  }

  setPaymentExecutor(execute: (payment: NoirPublicPayment) => Promise<void>): void {
    this.paymentExecutor = execute
  }

  private async serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const entry = this.queues.get(key) ?? { queue: new SerialTaskQueue(), count: 0 }
    entry.count += 1
    this.queues.set(key, entry)
    try {
      return await entry.queue.run(operation)
    } finally {
      entry.count -= 1
      if (entry.count === 0) this.queues.delete(key)
    }
  }

  private accountScopes() {
    return useWalletStore
      .getState()
      .wallets.flatMap(wallet =>
        wallet.accounts.map(account =>
          publicTransactionScope({ walletId: wallet.id, accountId: account.id })
        )
      )
  }

  async getAccount(context: NoirPublicRequestContext, refresh = true): Promise<NoirPublicAccount> {
    await assertPublicContext(context)
    const config = requirePublicConfig(context.network)
    const cached = await readPublicAccountProjection(context, config.parentContractId)
    if (cached && !refresh) {
      const key = queueKey(context, cached.publicKey)
      if (!this.accountRefreshes.has(key)) {
        const pending = this.getAccount(context, true)
          .then(account => {
            if (account.status !== cached.status || account.mcaId !== cached.mcaId)
              notifyChanged(context)
            return account
          })
          .finally(() => this.accountRefreshes.delete(key))
        this.accountRefreshes.set(key, pending)
        void pending.catch(() => {})
      }
      return cached
    }
    const identity = cached
      ? { pubkey: cached.publicKey, address: cached.address }
      : await this.deriveIdentity(context)
    await assertPublicContext(context)
    // Reimported aliases of the same key must share an in-flight payment.
    const pending = (
      await Promise.all(
        this.accountScopes().map(scope =>
          this.repository.getPendingActivation(
            scope,
            context.network,
            config.parentContractId,
            identity.pubkey
          )
        )
      )
    ).find(record => record !== null)
    let mcaId: string | null
    try {
      mcaId = await clientFor(context.network).getMcaByWallet(identity.pubkey)
    } catch (error) {
      if (cached) return cached
      throw error
    }
    await assertPublicContext(context)
    const account: NoirPublicAccount = {
      chain: 'zcash-l2',
      network: context.network,
      publicKey: identity.pubkey,
      address: identity.address,
      mcaId,
      parentContractId: config.parentContractId,
      status: mcaId ? 'active' : pending ? 'activating' : 'inactive',
      ...(pending ? { activationId: pending.graph.root.id } : {})
    }
    if (mcaId && pending) {
      await this.repository.applyActivationBound(
        pending.graph.root.scope,
        pending.graph.root.id,
        account,
        Date.now()
      )
    }
    await writePublicAccountProjection(context, account)
    return account
  }

  async getAssets(context: NoirPublicRequestContext, refresh = true): Promise<NoirPublicAssets> {
    const account = await this.getAccount(context, refresh)
    const config = requirePublicConfig(context.network)
    const tokens = config.assets
    const cached = await this.portfolio.read(account, context, tokens)
    if (!refresh || !account.mcaId) return cached
    const client = clientFor(context.network)
    const results = await Promise.allSettled(
      tokens.map(async token => {
        const [, balance] = await Promise.all([
          client.getFtMetadata(token.tokenId),
          client.getFtBalance(token.tokenId, account.mcaId!)
        ])
        return balance
      })
    )
    await assertPublicContext(context)
    const result: NoirPublicAssets = {
      account,
      assets: tokens.map((token, index) => {
        const balance = results[index]
        return balance.status === 'fulfilled'
          ? { ...token, balanceRaw: balance.value, status: 'fresh', updatedAt: Date.now() }
          : cached.assets[index]
      })
    }
    await this.portfolio.write(result, context)
    return result
  }

  private async getSigningCore(context: NoirPublicRequestContext) {
    if (this.identityReadiness && !(await this.identityReadiness()))
      throw new Error('Unlock the wallet to continue')
    await assertPublicContext(context)
    return backgroundZcashWalletRuntime.getWalletCore(context.walletId, context.accountId)
  }

  private async deriveIdentity(context: NoirPublicRequestContext) {
    return derivePublicIdentity(await this.getSigningCore(context), context.derivationIndex)
  }

  async getSigningIdentity(context: NoirPublicRequestContext) {
    const account = await this.getAccount(context, false)
    await assertPublicContext(context)
    return {
      pubkey: account.publicKey,
      address: account.address,
      signingMode: 'noir_protocol_public' as const
    }
  }

  async signMessage(
    context: NoirPublicRequestContext,
    message: string,
    approve: (action: 'publicSignMessage', data: unknown) => Promise<{ approved: boolean }>
  ) {
    const identity = await this.getSigningIdentity(context)
    const business = parsePublicSigningMessage(message)
    const account = await this.getAccount(context)
    if (account.publicKey !== identity.pubkey || account.address !== identity.address)
      throw new Error('Public signing identity changed')
    return this.serial(
      queueKey(context, business && account.mcaId ? account.mcaId : identity.pubkey),
      async () => {
        const client = clientFor(context.network)
        const checkBusiness = async () => {
          await assertPublicContext(context)
          if (!business) return
          if (!account.mcaId || account.status !== 'active')
            throw new Error('Activate the Public account before signing transactions')
          const deadline = Number(business.deadline)
          if (
            !Number.isSafeInteger(deadline) ||
            deadline <= Date.now() ||
            deadline > Date.now() + 5 * 60_000
          )
            throw new Error('Public transaction deadline must be within five minutes')
          if ((await client.getMcaByWallet(identity.pubkey)) !== account.mcaId)
            throw new Error('Public account binding changed')
          if ((await client.getMcaNonce(account.mcaId)) !== business.nonce)
            throw new Error('Public account nonce changed. Review a new request.')
          const pending = await this.repository.listPending(this.accountScopes(), context.network)
          if (
            pending.some(
              item =>
                'candidate' in item &&
                item.binding.accountAddress === account.mcaId &&
                BigInt(item.candidate.nonce) >= BigInt(business.nonce)
            )
          )
            throw new Error('An earlier Public transaction is still processing')
          await assertPublicContext(context)
        }
        await checkBusiness()
        if (
          !(
            await approve('publicSignMessage', {
              account,
              message,
              ...(business ? { business } : {})
            })
          ).approved
        )
          throw new Error('User rejected the signature request')
        return accountContextTransition.runActiveOperation(async () => {
          await checkBusiness()
          const core = await this.getSigningCore(context)
          await checkBusiness()
          const signature = await signPublicMessage(
            core,
            context.derivationIndex,
            identity.pubkey,
            message
          )
          await assertPublicContext(context)
          if (business && Date.now() >= Number(business.deadline))
            throw new Error('Public transaction expired')
          return { ...identity, signature }
        })
      }
    )
  }

  async activate(
    context: NoirPublicRequestContext,
    approve: NoirPublicApproval
  ): Promise<NoirPublicAccount> {
    const initial = await this.getAccount(context)
    return this.serial(queueKey(context, initial.publicKey), async () => {
      await assertPublicContext(context)
      const account = await this.getAccount(context)
      if (account.status !== 'inactive') return account
      const config = requirePublicConfig(context.network)
      const client = clientFor(context.network)
      // Recheck the binding without a cached fallback before preparing any payment.
      if (await client.getMcaByWallet(account.publicKey)) return this.getAccount(context)
      const core = await backgroundZcashWalletRuntime.getWalletCore(
        context.walletId,
        context.accountId
      )
      await assertPublicContext(context)
      const signature = await signPublicMessage(
        core,
        context.derivationIndex,
        account.publicKey,
        JSON.stringify([{ Zcash: account.publicKey }])
      )
      const fee = await client.getCreateMcaFee(config.zecTokenId)
      const refundAddress = useWalletStore
        .getState()
        .getAccount(context.walletId, context.accountId)?.addresses.transparent
      if (!refundAddress) throw new Error('Refund address is unavailable')
      const quote = await getPublicActivationQuote(
        createPublicActivationQuoteRequest({
          config,
          publicKey: account.publicKey,
          signature,
          refundAddress,
          amountOutRaw: fee
        }),
        config
      )
      assertPublicActivationQuoteForPayment(quote, config, fee)
      const expectedCreditRaw = (BigInt(quote.amountOutRaw) - BigInt(fee)).toString()
      const amount = formatBaseUnitDecimalAmount(quote.amountInRaw, 8)
      const feeRaw = await backgroundZcashWalletRuntime.estimateTransferFee(
        quote.depositAddress,
        amount,
        undefined,
        MARGINAL_FEE_ZATS.standard,
        'shielded'
      )
      await assertPublicContext(context)
      const expiresAt = Date.parse(quote.expiresAt)
      const review = {
        account,
        amount,
        fee: formatBaseUnitDecimalAmount(feeRaw, 8),
        creationFee: formatBaseUnitDecimalAmount(fee, 8),
        expectedCredit: formatBaseUnitDecimalAmount(expectedCreditRaw, 8),
        depositAddress: quote.depositAddress,
        expiresAt
      }
      if (!(await approve('publicActivate', review)).approved)
        throw new Error('User rejected Public activation')
      return accountContextTransition.runActiveOperation(async () => {
        await assertPublicContext(context)
        const bound = await client.getMcaByWallet(account.publicKey)
        if (bound) return this.getAccount(context)
        if ((await client.getCreateMcaFee(config.zecTokenId)) !== fee)
          throw new Error('Activation fee changed. Review a new quote.')
        assertPublicActivationQuoteForPayment(quote, config, fee)
        const currentFee = await core.estimateTransferFee(
          quote.depositAddress,
          amount,
          undefined,
          MARGINAL_FEE_ZATS.standard,
          'shielded'
        )
        if (BigInt(currentFee) > BigInt(feeRaw))
          throw new Error('Network fee increased. Review the activation again.')
        await assertPublicContext(context)
        if (!this.paymentExecutor) throw new Error('Public payment runtime is unavailable')
        const accountKey = buildAccountKey(context.network, context.walletId, context.accountId)
        const payment = await transactionRecorder.addTransaction({
          accountKey,
          transaction: {
            txHash: '',
            status: 'pending',
            type: 'send',
            amount,
            to: quote.depositAddress,
            from: useWalletStore.getState().getAccount(context.walletId, context.accountId)!
              .addresses.shielded,
            fromType: 'shielded',
            memo: '',
            fee: review.fee,
            timestamp: Date.now(),
            network: context.network,
            notified: false
          }
        })
        const record = await this.repository.createPreparedActivation({
          scope: publicTransactionScope(context),
          network: context.network,
          origin: context.origin,
          requestId: payment.id,
          activationId: payment.id,
          parentContractId: config.parentContractId,
          identityPublicKey: account.publicKey,
          now: Date.now(),
          paymentIntent: {
            depositAddress: quote.depositAddress,
            amountInRaw: quote.amountInRaw,
            amountOutRaw: quote.amountOutRaw,
            feeRaw,
            expiresAt,
            refundAddress,
            recipient: config.parentContractId,
            parentMessage: quote.request.customRecipientMsg
          }
        })
        const pending: NoirPublicAccount = {
          ...account,
          status: 'activating',
          activationId: record.graph.root.id
        }
        await writePublicAccountProjection(context, pending)
        await this.ensureMonitoring()
        await assertPublicContext(context)
        await this.paymentExecutor({
          context,
          transactionId: payment.id,
          depositAddress: quote.depositAddress,
          amount,
          expiresAt
        })
        await this.reconcileActivation(record)
        notifyChanged(context)
        return this.getAccount(context)
      })
    })
  }

  async send(
    context: NoirPublicRequestContext,
    value: unknown,
    approve: NoirPublicApproval
  ): Promise<NoirPublicTransaction> {
    const request = parseRequest(value)
    const account = await this.getAccount(context)
    if (!account.mcaId) throw new Error('Activate Public before sending a transaction')
    return this.serial(queueKey(context, account.mcaId), async () => {
      await assertPublicContext(context)
      const scope = publicTransactionScope(context)
      const previous = await this.repository.getByRequestId(
        scope,
        context.network,
        context.origin,
        request.requestId
      )
      if (previous) {
        if (
          previous.binding.requestFingerprint !==
          (await fingerprintPublicRequests(request.txRequests))
        ) {
          throw new Error('Public requestId was already used with a different transaction')
        }
        return (await this.reconcileTransaction(previous)).transaction
      }
      const pending = await this.repository.listPending(this.accountScopes(), context.network)
      const client = clientFor(context.network)
      if ((await client.getMcaByWallet(account.publicKey)) !== account.mcaId)
        throw new Error('Public account binding changed')
      const nonce = await client.getMcaNonce(account.mcaId!)
      if (
        pending.some(
          item =>
            'candidate' in item &&
            item.binding.accountAddress === account.mcaId &&
            item.graph.root.status !== 'final' &&
            item.graph.root.status !== 'failed' &&
            BigInt(item.candidate.nonce) >= BigInt(nonce)
        )
      ) {
        throw new Error('An earlier Public transaction is still processing')
      }
      const feeQuote = await client.getGasFeeQuote()
      const paid = buildPublicPaidRequests(
        request.txRequests,
        feeQuote,
        requirePublicConfig(context.network)
      )
      if (
        BigInt(
          await client.getFtBalance(requirePublicConfig(context.network).zecTokenId, account.mcaId!)
        ) < BigInt(paid.feeAmountRaw)
      ) {
        throw new Error('Insufficient Public ZEC balance for the execution fee')
      }
      const deadline = String(Date.now() + 5 * 60_000)
      await assertPublicContext(context)
      const review = {
        account,
        txRequests: paid.txRequests,
        nonce,
        deadline,
        tgas: paid.tgas,
        executionFee: {
          tokenId: requirePublicConfig(context.network).zecTokenId,
          amountRaw: paid.feeAmountRaw,
          recipient: feeQuote.feeAccount
        }
      }
      if (!(await approve('publicTransaction', review)).approved)
        throw new Error('User rejected the Public transaction')
      return accountContextTransition.runActiveOperation(async () => {
        await assertPublicContext(context)
        if (Date.now() >= Number(deadline)) throw new Error('Public transaction expired')
        if ((await client.getMcaNonce(account.mcaId!)) !== nonce)
          throw new Error('Public account nonce changed. Review a new request.')
        if ((await client.getMcaByWallet(account.publicKey)) !== account.mcaId)
          throw new Error('Public account binding changed')
        assertPublicFeeQuoteStillCovers(paid, feeQuote, await client.getGasFeeQuote())
        const core = await backgroundZcashWalletRuntime.getWalletCore(
          context.walletId,
          context.accountId
        )
        await assertPublicContext(context)
        const signature = await signPublicMessage(
          core,
          context.derivationIndex,
          account.publicKey,
          serializePublicBusiness({ nonce, deadline, txRequests: paid.txRequests })
        )
        await assertPublicContext(context)
        const candidate = createPublicCandidate({
          address: account.mcaId,
          nonce,
          deadline,
          txRequests: paid.txRequests,
          tgas: paid.tgas,
          publicKey: account.publicKey,
          signature
        })
        const record = await this.repository.createSigned({
          scope,
          network: context.network,
          origin: context.origin,
          requestId: request.requestId,
          accountAddress: account.mcaId!,
          parentContractId: account.parentContractId,
          identityPublicKey: account.publicKey,
          candidate,
          originalTxRequests: request.txRequests,
          now: Date.now()
        })
        await this.ensureMonitoring()
        await assertPublicContext(context)
        if (Date.now() >= Number(deadline)) throw new Error('Public transaction expired')
        try {
          await client.submitPublicTransaction(candidate)
          return (
            await this.repository.markSubmitted(
              scope,
              record.graph.root.id,
              record.binding.submissionId!,
              Date.now()
            )
          ).transaction
        } catch {
          // The POST may have executed. The durable candidate is reconciled as-is;
          // an unavailable status endpoint is never permission to sign or pay again.
          return (await this.reconcileTransaction(record)).transaction
        } finally {
          notifyChanged(context)
        }
      })
    })
  }

  async getTransaction(
    context: NoirPublicRequestContext,
    operationId: unknown
  ): Promise<NoirPublicTransaction | null> {
    if (typeof operationId !== 'string' || operationId.length > 512)
      throw new Error('Invalid Public operation ID')
    await assertPublicContext(context)
    const record = await this.repository.getByOperationId(
      publicTransactionScope(context),
      context.network,
      context.origin,
      operationId
    )
    if (!record) return null
    const result = await this.reconcileTransaction(record)
    await assertPublicContext(context)
    return result.transaction
  }

  private async reconcileTransaction(
    record: NoirPublicTransactionRecord
  ): Promise<NoirPublicTransactionRecord> {
    let current = record
    const client = clientFor(record.binding.network)
    try {
      const observation = await client.getPublicTransaction(record.binding.submissionId!)
      const execution = observation.tx_hash
        ? await client.verifiedPublicExecution(record.candidate, observation.tx_hash)
        : { status: 'unknown' as const }
      current = await this.repository.applyObservation(
        record.graph.root.scope,
        record.graph.root.id,
        {
          ...observation,
          ...(execution.status === 'verified'
            ? { verifiedExecution: 'success' as const }
            : execution.status === 'failed'
              ? { verifiedExecution: 'failure' as const }
              : {})
        },
        Date.now()
      )
      if (
        (current.transaction.status === 'final' || current.transaction.status === 'failed') &&
        current.transaction.status !== record.transaction.status
      ) {
        await this.refreshKnownAssets(current).catch(() => {})
      }
    } catch {
      // A missing API result is inconclusive. Only final chain evidence can
      // prove that an expired candidate can no longer consume its nonce.
    }
    if (
      current.transaction.status !== 'final' &&
      current.transaction.status !== 'failed' &&
      !current.transaction.transactionHash &&
      Date.now() > Number(current.candidate.deadline)
    ) {
      try {
        current = await this.repository.markExpiredUnexecuted(
          current.graph.root.scope,
          current.graph.root.id,
          await client.getMcaNonceSnapshot(current.binding.accountAddress),
          Date.now()
        )
      } catch {
        // Keep the original operation recoverable while chain evidence is unavailable.
      }
    }
    return current
  }

  private async reconcileActivation(record: NoirPublicActivationRecord): Promise<void> {
    const binding = record.binding
    const scope = record.graph.root.scope
    const mcaId = await clientFor(binding.network).getMcaByWallet(binding.identityPublicKey)
    if (mcaId) {
      const cached = await readPublicAccountProjection(
        { network: binding.network, walletId: scope.keyDomainId, accountId: scope.accountId },
        binding.parentContractId
      )
      const account: NoirPublicAccount = {
        chain: 'zcash-l2',
        network: binding.network,
        publicKey: binding.identityPublicKey,
        address: cached?.address ?? '',
        mcaId,
        parentContractId: binding.parentContractId,
        status: 'active'
      }
      await this.repository.applyActivationBound(scope, record.graph.root.id, account, Date.now())
      if (cached)
        await writePublicAccountProjection(
          { network: binding.network, walletId: scope.keyDomainId, accountId: scope.accountId },
          account
        )
      await this.refreshKnownAssets(record, mcaId).catch(() => {})
      notifyChanged({ walletId: scope.keyDomainId, accountId: scope.accountId })
      return
    }
    const transactions = await loadTransactions(
      buildAccountKey(binding.network, scope.keyDomainId, scope.accountId)
    )
    const payment = transactions.find(item => item.id === binding.activationId)
    if (payment?.txHash) {
      await this.repository.applyActivationPayment(
        scope,
        record.graph.root.id,
        payment.txHash,
        'confirming',
        Date.now()
      )
    }
  }

  private async ensureMonitoring(): Promise<void> {
    await chrome.alarms.create(PUBLIC_TRANSACTION_MONITOR_ALARM, { periodInMinutes: 0.5 })
  }

  private async refreshKnownAssets(
    record: NoirPublicActivationRecord,
    boundMcaId?: string
  ): Promise<void> {
    const binding = record.binding
    const scope = record.graph.root.scope
    const walletId = scope.keyDomainId
    const accountId = scope.accountId
    const retained = useWalletStore.getState().getAccount(walletId, accountId)
    if (!retained || binding.network !== DEFAULT_NETWORK) return
    const cached = await readPublicAccountProjection(
      { walletId, accountId, network: binding.network },
      binding.parentContractId
    )
    const mcaId =
      boundMcaId ?? (binding.kind === 'contract-call' ? binding.accountAddress : cached?.mcaId)
    if (!mcaId || (cached && cached.publicKey !== binding.identityPublicKey)) return
    const account: NoirPublicAccount = {
      chain: 'zcash-l2',
      network: binding.network,
      publicKey: binding.identityPublicKey,
      address: cached?.address ?? '',
      mcaId,
      parentContractId: binding.parentContractId,
      status: 'active'
    }
    const context = { walletId, accountId, derivationIndex: retained.derivationIndex }
    const tokens = requirePublicConfig(binding.network).assets
    const previous = await this.portfolio.read(account, context, tokens)
    const client = clientFor(binding.network)
    const balances = await Promise.allSettled(
      tokens.map(async token => {
        const [, balance] = await Promise.all([
          client.getFtMetadata(token.tokenId),
          client.getFtBalance(token.tokenId, mcaId)
        ])
        return balance
      })
    )
    await this.portfolio.write(
      {
        account,
        assets: tokens.map((token, index) => {
          const result = balances[index]
          return result.status === 'fulfilled'
            ? {
                ...token,
                balanceRaw: result.value,
                status: 'fresh' as const,
                updatedAt: Date.now()
              }
            : previous.assets[index]
        })
      },
      context
    )
    notifyChanged(context)
  }

  resume(): Promise<void> {
    return this.monitor.run(async () => {
      if (DEFAULT_NETWORK !== 'mainnet') return
      await rehydrateWalletStore()
      const pending = await this.repository.listPending(this.accountScopes(), DEFAULT_NETWORK)
      if (!pending.length) {
        await chrome.alarms.clear(PUBLIC_TRANSACTION_MONITOR_ALARM)
        return
      }
      await this.ensureMonitoring()
      for (const record of pending) {
        if ('transaction' in record) await this.reconcileTransaction(record)
        else await this.reconcileActivation(record).catch(() => {})
      }
    })
  }
}

export const noirPublicRuntime = new NoirPublicRuntime()
