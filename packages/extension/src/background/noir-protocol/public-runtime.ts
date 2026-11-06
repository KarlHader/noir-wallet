import { checkLendingMcaAccount } from '@/core/services/lending-service'
import { fetchCachedIdentity } from '@/core/wallet/identity-cache'
import { resolveNearRuntimeNetworkConfig } from '@/core/chains/solana-near-runtime-config'
import { requirePublicConfig } from '@/core/services/noir-protocol/public/config'
import {
  assertPublicFeeQuoteStillCovers,
  buildPublicPaidRequests
} from '@/core/services/noir-protocol/public/fee'
import { signPublicMessage } from '@/core/services/noir-protocol/public/identity'
import {
  assertPublicActivationQuoteForPayment,
  createPublicActivationQuoteRequest
} from '@/core/services/noir-protocol/public/activation-quote'
import {
  createPublicCandidate,
  computePublicSubmissionId,
  parsePublicFunctionCallRequests,
  serializePublicBusiness
} from '@/core/services/noir-protocol/public/protocol'
import type {
  NoirPublicAccount,
  NoirPublicAssets,
  NoirPublicTransaction,
  NoirPublicTransactionParams
} from '@/core/services/noir-protocol/public/types'
import {
  IndexedDbTransactionRepository,
  IndexedDbStorageV2Repository
} from '@/infrastructure/persistence/repositories'
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
import { signPublicEvmMessage } from './public-evm-signing'
import { getEvmNetworkConfigs } from '@/config/networks'
import { getEvmNativeProtocolAssetId } from '@/config/asset-market-assets'
import { parseChainId } from '@/core/chains/registry'
import { parseTransactionId } from '@/core/transactions/domain'
import { createBackgroundEvmTransferAssetRegistry } from '../evm-transfer-assets'
import type { BackgroundEvmTransferRouter } from '../evm-transfer-router'

export const PUBLIC_TRANSACTION_MONITOR_ALARM = 'noir-public-monitor'

type NoirPublicApproval<Action extends string = 'publicActivate' | 'publicTransaction'> = (
  action: Action,
  data: unknown
) => Promise<{ approved: boolean }>

export interface NoirPublicPayment {
  readonly context: NoirPublicRequestContext
  readonly transactionId: string
  readonly depositAddress: string
  readonly amount: string
  readonly expiresAt: number
  readonly marginalFeeZats: number
  readonly feeQuoteId: string
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

function notifyChanged(context: Pick<NoirPublicRequestContext, 'walletId' | 'accountId'>): void {
  void chrome.runtime
    .sendMessage({
      type: 'PORTFOLIO_UPDATED',
      walletId: context.walletId,
      accountId: context.accountId
    })
    .catch(() => {})
}

export class NoirPublicRuntime {
  private readonly repository = new NoirPublicTransactionRepository(
    new IndexedDbTransactionRepository()
  )
  private readonly portfolio = new NoirPublicPortfolioCache()
  private readonly queues = new Map<string, { queue: SerialTaskQueue; count: number }>()
  private readonly monitor = new DedupPromise<void>()
  private readonly accountRefreshes = new Map<string, Promise<NoirPublicAccount>>()
  private paymentExecutor: ((payment: NoirPublicPayment) => Promise<void>) | null = null
  private evmPaymentRouter: BackgroundEvmTransferRouter | null = null
  private identityReadiness: (() => Promise<boolean>) | null = null

  setIdentityReadiness(ready: () => Promise<boolean>): void {
    this.identityReadiness = ready
  }

  setPaymentExecutor(execute: (payment: NoirPublicPayment) => Promise<void>): void {
    this.paymentExecutor = execute
  }

  setEvmPaymentRouter(router: BackgroundEvmTransferRouter | null): void {
    this.evmPaymentRouter = router
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

  private async accountScopes(context?: NoirPublicRequestContext) {
    const legacy = useWalletStore
      .getState()
      .wallets.flatMap(wallet =>
        wallet.accounts.map(account =>
          publicTransactionScope({ walletId: wallet.id, accountId: account.id })
        )
      )
    const storage = new IndexedDbStorageV2Repository()
    const pointer = await storage.getActivePointer()
    const snapshot = pointer ? await storage.getSnapshot(pointer.generationId) : null
    const native =
      snapshot?.manifest.status === 'verified' &&
      snapshot.manifest.sourceFingerprint === pointer?.sourceFingerprint
        ? snapshot.accounts.map(account => ({
            keyDomainId: account.keyDomainId,
            accountId: account.id
          }))
        : []
    const scopes = [...legacy, ...native, ...(context ? [publicTransactionScope(context)] : [])]
    return scopes.filter(
      (scope, index) =>
        scopes.findIndex(
          candidate =>
            candidate.keyDomainId === scope.keyDomainId && candidate.accountId === scope.accountId
        ) === index
    )
  }

  async getAccount(context: NoirPublicRequestContext, refresh = true): Promise<NoirPublicAccount> {
    await assertPublicContext(context)
    const config = requirePublicConfig(context.network)
    const cached = await readPublicAccountProjection(
      context,
      config.parentContractId,
      context.chainId ? 'evm' : 'zcash-l2'
    )
    if (
      cached &&
      cached.chain === (context.chainId ? 'evm' : 'zcash-l2') &&
      (!context.chainId || cached.publicKey === context.evmAddress) &&
      !refresh
    ) {
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
    // This projection only contains identities selected by the shared Lending resolver.
    // Read-only refreshes must not depend on restoring the signing Worker after a restart.
    const identity = context.chainId
      ? { pubkey: context.evmAddress!, address: context.evmAddress!, signingMode: 'evm' as const }
      : cached
        ? { pubkey: cached.publicKey, address: cached.address, signingMode: cached.signingMode }
        : await this.deriveIdentity(context)
    await assertPublicContext(context)
    // Reimported aliases of the same key must share an in-flight payment.
    const pending = (
      await Promise.all(
        (await this.accountScopes(context)).map(scope =>
          this.repository.getPendingActivation(
            scope,
            context.network,
            config.parentContractId,
            identity.pubkey,
            context.chainId ? 'evm' : 'zcash'
          )
        )
      )
    ).find(record => record !== null)
    let mcaId: string | null
    try {
      mcaId = await clientFor(context.network).getMcaByWallet(
        identity.pubkey,
        undefined,
        context.chainId ? 'evm' : 'zcash'
      )
    } catch (error) {
      await assertPublicContext(context)
      if (cached?.publicKey === identity.pubkey && cached.signingMode === identity.signingMode)
        return cached
      throw error
    }
    await assertPublicContext(context)
    const account: NoirPublicAccount = {
      chain: context.chainId ? 'evm' : 'zcash-l2',
      network: context.network,
      publicKey: identity.pubkey,
      signingMode: identity.signingMode,
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
    if (context.chainId) throw new Error('EVM identity must come from the authorized scope')
    const core = await this.getSigningCore(context)
    const resolve = (mode: 'derived' | 'legacy_index0') =>
      fetchCachedIdentity(
        context.network,
        context.walletId,
        context.accountId,
        context.derivationIndex,
        mode,
        core
      )
    const status = await checkLendingMcaAccount(
      context.walletId,
      context.accountId,
      async mode => (await resolve(mode === 'derived' ? 'derived' : 'legacy_index0')).pubkey
    )
    await assertPublicContext(context)
    const signingMode: 'derived' | 'legacy_index0' =
      status.signingMode === 'derived' ? 'derived' : 'legacy_index0'
    const identity = await resolve(signingMode)
    if (identity.pubkey !== status.publicKey) throw new Error('Lending signing identity changed')
    return { ...identity, signingMode }
  }

  async getPublicKey(context: NoirPublicRequestContext) {
    const account = await this.getAccount(context, false)
    await assertPublicContext(context)
    return {
      pubkey: account.publicKey,
      address: account.address,
      signingMode: account.signingMode,
      network: context.network
    }
  }

  private async signZcashMessage(
    context: NoirPublicRequestContext,
    account: NoirPublicAccount,
    message: string
  ): Promise<string> {
    if (account.signingMode === 'evm') throw new Error('Zcash signing identity changed')
    return signPublicMessage(
      await this.getSigningCore(context),
      context.derivationIndex,
      account.publicKey,
      message,
      account.signingMode
    )
  }

  async signMessage(
    context: NoirPublicRequestContext,
    value: unknown,
    approve: NoirPublicApproval<'signMessage' | 'evmMessage'>
  ) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096)
      throw new Error('Invalid Public message')
    const account = await this.getAccount(context, false)
    await assertPublicContext(context)
    if (!context.chainId && !(await approve('signMessage', { message: value })).approved)
      throw new Error('User rejected the signature request')
    return accountContextTransition.runActiveOperation(async () => {
      await assertPublicContext(context)
      const signature = context.chainId
        ? await signPublicEvmMessage(context, value, review =>
            approve('evmMessage', {
              chainName: context.chainId,
              executionMode: context.evmExecutionMode,
              review,
              method: 'personal_sign',
              message: value
            })
          )
        : await this.signZcashMessage(context, account, value)
      await assertPublicContext(context)
      return {
        signature,
        pubkey: account.publicKey,
        address: account.address,
        signingMode: account.signingMode,
        network: context.network
      }
    })
  }

  async activate(
    context: NoirPublicRequestContext,
    approve: NoirPublicApproval<'publicActivate'>,
    approveEvmPayment?: NoirPublicApproval<'evmTransaction'>
  ): Promise<NoirPublicAccount> {
    if (context.chainId) {
      if (!approveEvmPayment) throw new Error('Public EVM payment approval is unavailable')
      return this.activateEvm(context, approve, approveEvmPayment)
    }
    const initial = await this.getAccount(context)
    return this.serial(queueKey(context, initial.publicKey), async () => {
      await assertPublicContext(context)
      const account = await this.getAccount(context)
      if (account.status !== 'inactive') return account
      const config = requirePublicConfig(context.network)
      const client = clientFor(context.network)
      // Recheck the binding without a cached fallback before preparing any payment.
      if (
        await client.getMcaByWallet(
          account.publicKey,
          undefined,
          account.chain === 'evm' ? 'evm' : 'zcash'
        )
      )
        return this.getAccount(context)
      const core = await backgroundZcashWalletRuntime.getWalletCore(
        context.walletId,
        context.accountId
      )
      await assertPublicContext(context)
      const signature = await this.signZcashMessage(
        context,
        account,
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
      const feeQuote = await core.getFeeQuote()
      const feeEstimate = await backgroundZcashWalletRuntime.estimateTransferFee(
        quote.depositAddress,
        amount,
        undefined,
        feeQuote.standardMarginalFeeZats,
        'shielded',
        undefined,
        feeQuote.id
      )
      const feeRaw = feeEstimate.feeZats
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
          feeQuote.standardMarginalFeeZats,
          'shielded',
          undefined,
          feeQuote.id
        )
        if (
          currentFee.feeQuote.id !== feeQuote.id ||
          currentFee.marginalFeeZats !== feeEstimate.marginalFeeZats ||
          currentFee.feeZats !== feeRaw
        )
          throw new Error('Network fee changed. Review the activation again.')
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
          expiresAt,
          marginalFeeZats: feeQuote.standardMarginalFeeZats,
          feeQuoteId: feeQuote.id
        })
        await this.reconcileActivation(record)
        notifyChanged(context)
        return this.getAccount(context)
      })
    })
  }

  private async activateEvm(
    context: NoirPublicRequestContext,
    approve: NoirPublicApproval<'publicActivate'>,
    approvePayment: NoirPublicApproval<'evmTransaction'>
  ): Promise<NoirPublicAccount> {
    if (!context.chainId || !context.evmAddress || !context.evmExecutionMode)
      throw new Error('Public EVM account is unavailable')
    const chainId = parseChainId(context.chainId).id
    const initial = await this.getAccount(context)
    return this.serial(queueKey(context, initial.publicKey), async () => {
      await assertPublicContext(context)
      const account = await this.getAccount(context)
      if (account.status !== 'inactive') return account
      const router = this.evmPaymentRouter
      if (!router) throw new Error('EVM transfer is unavailable')
      const network = getEvmNetworkConfigs(context.network).find(item => item.chainId === chainId)
      const protocolAssetId = getEvmNativeProtocolAssetId(chainId)
      if (!network || !protocolAssetId) throw new Error('Public EVM payment asset is unavailable')
      const native = createBackgroundEvmTransferAssetRegistry(network, [])
        .list(chainId)
        .find(entry => entry.asset.kind === 'native')
      if (!native) throw new Error('EVM native asset is unavailable')
      const config = requirePublicConfig(context.network)
      const client = clientFor(context.network)
      if (await client.getMcaByWallet(account.publicKey, undefined, 'evm'))
        return this.getAccount(context)
      const message = JSON.stringify([{ EVM: account.publicKey.slice(2) }])
      const signature = await signPublicEvmMessage(context, message)
      const fee = await client.getCreateMcaFee(config.zecTokenId)
      const quote = await getPublicActivationQuote(
        createPublicActivationQuoteRequest({
          config,
          publicKey: account.publicKey,
          signature,
          evmSource: { chainId, protocolAssetId },
          refundAddress: account.address,
          amountOutRaw: fee
        }),
        config
      )
      assertPublicActivationQuoteForPayment(quote, config, fee)
      if (!/^0x[0-9a-fA-F]{40}$/.test(quote.depositAddress))
        throw new Error('Public EVM deposit address is invalid')
      const expiresAt = Date.parse(quote.expiresAt)
      const prepared = await router.prepare(
        { assetId: native.asset.id, recipient: quote.depositAddress, amountRaw: quote.amountInRaw },
        undefined,
        undefined,
        context.evmExecutionMode
      )
      const transferId = prepared.graph.root.id
      const scope = publicTransactionScope(context)
      const feeLimit = prepared.graph.root.intent?.feeLimit?.amountRaw
      try {
        if (
          prepared.graph.root.scope.keyDomainId !== scope.keyDomainId ||
          prepared.graph.root.scope.accountId !== scope.accountId ||
          prepared.review.chainId !== chainId ||
          typeof feeLimit !== 'string'
        )
          throw new Error('EVM payment review does not match the Public account')
        const review = {
          account,
          chainId,
          executionModeRevision: context.executionModeRevision,
          sourceSymbol: native.metadata.symbol,
          amount: formatBaseUnitDecimalAmount(quote.amountInRaw, native.metadata.decimals),
          fee: formatBaseUnitDecimalAmount(feeLimit, native.metadata.decimals),
          creationFee: formatBaseUnitDecimalAmount(fee, 8),
          expectedCredit: formatBaseUnitDecimalAmount(
            (BigInt(quote.amountOutRaw) - BigInt(fee)).toString(),
            8
          ),
          depositAddress: quote.depositAddress,
          expiresAt
        }
        await assertPublicContext(context)
        if (!(await approve('publicActivate', review)).approved)
          throw new Error('User rejected Public activation')
        await assertPublicContext(context)
        const paymentDecision = await approvePayment('evmTransaction', {
          chainName: network.displayName,
          iconChain: network.iconChain,
          executionMode: context.evmExecutionMode,
          privacyRoute: 'onchain',
          nativeCurrency: network.nativeCurrency,
          token: null,
          review: prepared.review,
          intent: {
            assetId: native.asset.id,
            recipient: quote.depositAddress,
            amountRaw: quote.amountInRaw
          },
          feeSelection: { kind: 'tier', tier: 'standard' },
          feeTier: 'standard',
          feeEditingAvailable: false
        })
        if (!paymentDecision.approved) throw new Error('User rejected the EVM payment')
      } catch (error) {
        await router.reject(transferId).catch(() => {})
        throw error
      }
      let paymentSubmitted = false
      let activationId: string | null = null
      try {
        await assertPublicContext(context)
        if (await client.getMcaByWallet(account.publicKey, undefined, 'evm')) {
          await router.reject(transferId)
          return this.getAccount(context)
        }
        if ((await client.getCreateMcaFee(config.zecTokenId)) !== fee)
          throw new Error('Activation fee changed. Review a new quote.')
        assertPublicActivationQuoteForPayment(quote, config, fee)
        if (Date.now() >= expiresAt) throw new Error('Public activation quote expired')
        const pendingTransfer = await router.getPendingApproval(transferId)
        if (
          !pendingTransfer ||
          pendingTransfer.review.payloadFingerprint.digestHex !==
            prepared.review.payloadFingerprint.digestHex
        )
          throw new Error('EVM payment changed. Review a new activation.')
        await assertPublicContext(context)
        const record = await this.repository.createPreparedActivation({
          scope,
          network: context.network,
          origin: context.origin,
          requestId: transferId,
          activationId: transferId,
          parentContractId: config.parentContractId,
          identityPublicKey: account.publicKey,
          identityChain: 'evm',
          preparedTransferGraph: pendingTransfer.graph,
          now: Date.now(),
          paymentIntent: {
            depositAddress: quote.depositAddress,
            amountInRaw: quote.amountInRaw,
            amountOutRaw: quote.amountOutRaw,
            feeRaw: feeLimit,
            expiresAt,
            refundAddress: account.address,
            recipient: config.parentContractId,
            parentMessage: quote.request.customRecipientMsg,
            evmPayment: {
              chainId,
              assetId: native.asset.id,
              protocolAssetId,
              accountAddress: account.address,
              transactionId: transferId
            }
          }
        })
        activationId = record.graph.root.id
        await writePublicAccountProjection(context, {
          ...account,
          status: 'activating',
          activationId: record.graph.root.id
        })
        await this.ensureMonitoring()
        paymentSubmitted = true
        try {
          const submission = await router.approveForPublic(
            transferId,
            prepared.review.payloadFingerprint.digestHex,
            async active => {
              await assertPublicContext(context)
              if (
                active.generationId !== context.generationId ||
                active.chainAccount.scope.keyDomainId !== scope.keyDomainId ||
                active.chainAccount.scope.accountId !== scope.accountId ||
                active.chainAccount.scope.chainId !== chainId
              )
                throw new Error('EVM payment account changed before approval')
            }
          )
          if (submission.status === 'external-signature-required')
            throw new Error('Public EVM activation requires a software account')
        } catch (error) {
          const payment = await new IndexedDbTransactionRepository().get(
            scope,
            parseTransactionId(transferId)
          )
          const transactionHash = payment?.segments.find(segment => segment.role === 'origin')
            ?.evidence?.transactionHash
          if (!transactionHash && (!payment || payment.root.status === 'failed')) {
            const failedTransfer = await router
              .rejectForScopeWithGraph(transferId, scope)
              .catch(() => null)
            if (failedTransfer || payment?.root.status === 'failed')
              await this.repository.markEvmActivationPaymentRejected(
                scope,
                record.graph.root.id,
                Date.now(),
                failedTransfer ?? undefined
              )
            throw error
          }
          // A signed transfer may still broadcast after an ambiguous response.
        }
        await this.reconcileActivation(record)
        notifyChanged(context)
        return this.getAccount(context)
      } catch (error) {
        if (!paymentSubmitted) {
          const failedTransfer = await router
            .rejectForScopeWithGraph(transferId, scope)
            .catch(() => null)
          if (activationId) {
            await this.repository
              .markEvmActivationPaymentRejected(
                scope,
                activationId,
                Date.now(),
                failedTransfer ?? undefined
              )
              .catch(() => {})
          }
        }
        throw error
      }
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
        request.requestId,
        context.chainId ? 'evm' : 'zcash'
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
      const pending = await this.repository.listPending(
        await this.accountScopes(context),
        context.network
      )
      const client = clientFor(context.network)
      if (
        (await client.getMcaByWallet(
          account.publicKey,
          undefined,
          account.chain === 'evm' ? 'evm' : 'zcash'
        )) !== account.mcaId
      )
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
        ...(context.chainId
          ? { chainId: context.chainId, executionModeRevision: context.executionModeRevision }
          : {}),
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
        if (
          (await client.getMcaByWallet(
            account.publicKey,
            undefined,
            account.chain === 'evm' ? 'evm' : 'zcash'
          )) !== account.mcaId
        )
          throw new Error('Public account binding changed')
        assertPublicFeeQuoteStillCovers(paid, feeQuote, await client.getGasFeeQuote())
        const business = serializePublicBusiness({ nonce, deadline, txRequests: paid.txRequests })
        const signature = context.chainId
          ? await signPublicEvmMessage(context, business)
          : await this.signZcashMessage(context, account, business)
        await assertPublicContext(context)
        const candidate = createPublicCandidate({
          address: account.mcaId,
          nonce,
          deadline,
          txRequests: paid.txRequests,
          tgas: paid.tgas,
          publicKey: account.publicKey,
          signature,
          ...(context.chainId ? { identityChain: 'evm' as const } : {})
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
      operationId,
      context.chainId ? 'evm' : 'zcash'
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
      // Old durable requests retain their binding and signed bytes. Only their
      // lookup identifier changes; recovery never signs or submits them again.
      const hash =
        record.candidate.tgas === undefined
          ? record.binding.submissionId!
          : computePublicSubmissionId(record.candidate)
      const remote = await client.getPublicTransaction(hash)
      const observation = { ...remote, submission_id: record.binding.submissionId! }
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
    const mcaId = await clientFor(binding.network).getMcaByWallet(
      binding.identityPublicKey,
      undefined,
      binding.identityChain ?? 'zcash'
    )
    if (mcaId) {
      const cached = await readPublicAccountProjection(
        { network: binding.network, walletId: scope.keyDomainId, accountId: scope.accountId },
        binding.parentContractId,
        binding.identityChain === 'evm' ? 'evm' : 'zcash-l2'
      )
      const account = {
        chain: binding.identityChain === 'evm' ? ('evm' as const) : ('zcash-l2' as const),
        network: binding.network,
        publicKey: binding.identityPublicKey,
        address: cached?.address ?? '',
        mcaId,
        parentContractId: binding.parentContractId,
        status: 'active' as const
      }
      await this.repository.applyActivationBound(scope, record.graph.root.id, account, Date.now())
      if (cached?.publicKey === binding.identityPublicKey)
        await writePublicAccountProjection(
          { network: binding.network, walletId: scope.keyDomainId, accountId: scope.accountId },
          { ...cached, mcaId, status: 'active' }
        )
      await this.refreshKnownAssets(record, mcaId).catch(() => {})
      notifyChanged({ walletId: scope.keyDomainId, accountId: scope.accountId })
      return
    }
    if (binding.identityChain === 'evm') {
      const paymentId = binding.paymentIntent?.evmPayment?.transactionId
      if (!paymentId) throw new Error('Public EVM activation payment binding is missing')
      const payment = await new IndexedDbTransactionRepository().get(
        scope,
        parseTransactionId(paymentId)
      )
      if (!payment) {
        const router = this.evmPaymentRouter
        if (!router) return
        if (await router.hasPendingTransferForScope(paymentId, scope)) return
        await this.repository.markEvmActivationPaymentAbandoned(
          scope,
          record.graph.root.id,
          Date.now(),
          async () => !(await router.hasPendingTransferForScope(paymentId, scope))
        )
        return
      }
      const transactionHash = payment.segments.find(segment => segment.role === 'origin')?.evidence
        ?.transactionHash
      if (payment.root.status === 'failed' && !transactionHash) {
        await this.repository.markEvmActivationPaymentRejected(
          scope,
          record.graph.root.id,
          Date.now()
        )
        return
      }
      if (
        transactionHash &&
        (payment.root.status === 'broadcast' ||
          payment.root.status === 'confirming' ||
          payment.root.status === 'final')
      ) {
        await this.repository.applyActivationPayment(
          scope,
          record.graph.root.id,
          transactionHash,
          payment.root.status,
          Date.now()
        )
      }
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
    if ((!retained && binding.identityChain !== 'evm') || binding.network !== DEFAULT_NETWORK)
      return
    const cached = await readPublicAccountProjection(
      { walletId, accountId, network: binding.network },
      binding.parentContractId,
      binding.identityChain === 'evm' ? 'evm' : 'zcash-l2'
    )
    const mcaId =
      boundMcaId ?? (binding.kind === 'contract-call' ? binding.accountAddress : cached?.mcaId)
    if (!mcaId || !cached || cached.publicKey !== binding.identityPublicKey) return
    const account: NoirPublicAccount = {
      chain: binding.identityChain === 'evm' ? 'evm' : 'zcash-l2',
      network: binding.network,
      publicKey: binding.identityPublicKey,
      signingMode: cached.signingMode,
      address: cached.address,
      mcaId,
      parentContractId: binding.parentContractId,
      status: 'active'
    }
    const context = { walletId, accountId, derivationIndex: retained?.derivationIndex ?? 0 }
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
      const pending = await this.repository.listPending(await this.accountScopes(), DEFAULT_NETWORK)
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
