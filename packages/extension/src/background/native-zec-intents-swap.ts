import { isAddress } from 'viem'
import type { AssetRegistry } from '@/core/chains/registry'
import { getZcashChainId, parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import { NOIR_RECEIVE_REFERRAL, NOIR_SWAP_REFERRAL, ZEC_ZCASH_ASSET } from '@/config/intents'
import type { EvmNetworkConfig } from '@/config/networks'
import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import {
  fetchQuote,
  parseSwapStatusResponse,
  refreshSwapTokenCatalog,
  type SwapStatus
} from '@/core/services/intents-api'
import {
  assertConfidentialQuoteBinding,
  type ConfidentialQuote
} from '@/core/services/confidential-funding'
import { resolveManagedIntentsAsset } from '@/core/services/intents-managed-assets'
import { resolveIntentsEvmChainId } from '@/core/services/intents-evm-assets'
import { resolveIntentsWalletAsset } from '@/core/services/intents-wallet-assets'
import {
  createOneClickOrder,
  parseOneClickDepositMemo,
  type OneClickOrder,
  type OneClickViewer
} from '@/core/services/near-intents/one-click-order'
import {
  sameNativeZecQuoteBinding,
  zatsToZec,
  zecToZats,
  type NativeZecIntentsSwapRecord,
  type NativeZecIntentsSwapReview,
  type PrepareNativeZecIntentsSwapInput
} from '@/core/services/native-zec-intents-swap'
import { SerialTaskQueue } from '@/lib/async-utils'
import { withUndeletedWalletAccountMetadata } from '@/lib/wallet-metadata-storage'
import { withMetadataLock } from '@/lib/wallet-metadata-storage'
import { readConfidentialQuoteAppFees } from './confidential-funding-api'
import { credentialSession } from './credential-session'
import { queryOneClickOrderStatus, resolveZcashOneClickViewer } from './one-click-status'
import type { FundingSource, Network, QuoteBinding } from '@/types/wallet'

const PREFIX = 'native_zec_intents_swap:'
const INDEX_KEY = `${PREFIX}index`
const ID_PATTERN = /^[a-zA-Z0-9:_-]{1,160}$/
const AMOUNT_PATTERN = /^[1-9][0-9]{0,77}$/
const MAX_STORED_QUOTES = 128
const EXPIRED_QUOTE_RETENTION_MS = 24 * 60 * 60_000

export interface NativeZecActiveAccountSnapshot {
  readonly network: Network
  readonly walletId: string | null
  readonly accountId: string | null
  readonly refundAddresses: readonly string[]
  readonly shieldedRefundAddressHistory?: readonly string[]
}

interface NativeZecAccountScope {
  readonly network: Network
  readonly walletId: string
  readonly accountId: string
}

function isShieldedRefund(scheme: string): boolean {
  return scheme === 'zcash-full-unified' || scheme === 'zcash-sapling'
}

function assertNativeZecOrder(
  order: OneClickOrder,
  depositAddress: string,
  refundAddress: string,
  network: Network,
  confidentialRecipient?: string
): void {
  const refund = parseZcashAddress(refundAddress, network)
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    throw new Error('Native ZEC 1Click order binding is invalid')
  }
  const viewer = order.viewer
  if (order.depositMemo !== undefined) parseOneClickDepositMemo(order.depositMemo)
  const recipientOwnsOrder =
    refund.scheme === 'zcash-transparent-p2pkh' &&
    viewer?.chainFamily === 'evm' &&
    viewer.signingMode === 'public' &&
    confidentialRecipient !== undefined &&
    isAddress(confidentialRecipient) &&
    viewer.walletAddress === confidentialRecipient
  if (
    order.depositAddress !== depositAddress ||
    (viewer !== undefined &&
      !recipientOwnsOrder &&
      (!viewer ||
        viewer.chainFamily !== 'zcash' ||
        parseZcashAddress(viewer.walletAddress, network).scheme !== 'zcash-transparent-p2pkh' ||
        (isShieldedRefund(refund.scheme)
          ? viewer.signingMode !== 'derived'
          : viewer.walletAddress !== refund.address || viewer.signingMode !== 'transparent')))
  ) {
    throw new Error('Native ZEC 1Click order binding is invalid')
  }
}

function getConfidentialOrderRecipient(binding: QuoteBinding): string | undefined {
  return binding.recipientType === 'CONFIDENTIAL_INTENTS' &&
    binding.userAction === 'swap' &&
    (binding.fundingSource === 'transparent' || binding.fundingSource === 'shielded') &&
    binding.destinationAsset === ZEC_ZCASH_ASSET
    ? binding.recipient
    : undefined
}

function recordKey(quoteId: string): string {
  if (!ID_PATTERN.test(quoteId)) throw new Error('Native ZEC Intents quote ID is invalid')
  return `${PREFIX}${quoteId}`
}

function parseRecord(value: unknown): NativeZecIntentsSwapRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored native ZEC Intents quote is invalid')
  }
  const record = value as NativeZecIntentsSwapRecord
  if (
    (record.schemaVersion !== 1 && record.schemaVersion !== 2) ||
    !ID_PATTERN.test(record.quoteId) ||
    record.network !== 'mainnet' ||
    !ID_PATTERN.test(record.walletId) ||
    !ID_PATTERN.test(record.accountId) ||
    !AMOUNT_PATTERN.test(record.amountZats) ||
    record.amountZec !== zatsToZec(record.amountZats) ||
    !record.destination ||
    typeof record.destination !== 'object' ||
    typeof record.destinationBlockchain !== 'string' ||
    record.destinationBlockchain.length === 0 ||
    record.destinationBlockchain.length > 64 ||
    typeof record.destinationSymbol !== 'string' ||
    record.destinationSymbol.length === 0 ||
    record.destinationSymbol.length > 64 ||
    !Number.isSafeInteger(record.destinationDecimals) ||
    record.destinationDecimals < 0 ||
    record.destinationDecimals > 255 ||
    !Number.isSafeInteger(record.expiresAt) ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.slippageBps) ||
    record.slippageBps < 0 ||
    record.slippageBps > 10_000 ||
    (record.requestId !== undefined && !ID_PATTERN.test(record.requestId)) ||
    (record.claimedTransactionId !== undefined && !ID_PATTERN.test(record.claimedTransactionId)) ||
    (record.terminalStatus !== undefined &&
      !['SUCCESS', 'REFUNDED', 'FAILED'].includes(record.terminalStatus)) ||
    (record.terminalAt !== undefined && !Number.isSafeInteger(record.terminalAt)) ||
    (record.terminalStatus === undefined) !== (record.terminalAt === undefined) ||
    (record.terminalStatus !== undefined && !record.claimedTransactionId) ||
    !AMOUNT_PATTERN.test(record.expectedOutputRaw) ||
    !AMOUNT_PATTERN.test(record.minimumOutputRaw) ||
    BigInt(record.minimumOutputRaw) > BigInt(record.expectedOutputRaw) ||
    (record.appFeeBps !== undefined &&
      (!Number.isSafeInteger(record.appFeeBps) ||
        record.appFeeBps < 0 ||
        record.appFeeBps > 10_000)) ||
    !record.quoteBinding ||
    record.quoteBinding.provider !== 'near-intents' ||
    record.quoteBinding.isCrossChain !== true ||
    record.quoteBinding.quoteHandle !== record.quoteId ||
    record.quoteBinding.depositAddress !== record.depositAddress ||
    record.quoteBinding.originAsset !== ZEC_ZCASH_ASSET ||
    record.quoteBinding.destinationAsset !== record.destination.protocolAssetId ||
    record.quoteBinding.destinationChain !== record.destination.chainId ||
    record.quoteBinding.recipient !== record.destination.recipient ||
    record.quoteBinding.refundTo !== record.refundAddress ||
    record.quoteBinding.expectedAmountOut !== record.expectedOutputRaw ||
    record.quoteBinding.minAmountOut !== record.minimumOutputRaw ||
    record.quoteBinding.deadline !== record.expiresAt
  ) {
    throw new Error('Stored native ZEC Intents quote bindings are invalid')
  }
  parseZcashAddress(record.depositAddress, record.network)
  const refund = parseZcashAddress(record.refundAddress, record.network)
  if (record.quoteBinding.oneClickOrder !== undefined) {
    assertNativeZecOrder(
      record.quoteBinding.oneClickOrder,
      record.depositAddress,
      record.refundAddress,
      record.network,
      getConfidentialOrderRecipient(record.quoteBinding)
    )
  }
  parseAssetId(record.destination.assetId)
  parseChainId(record.destination.chainId)
  if (record.schemaVersion === 1) {
    if (
      record.recipientType !== undefined ||
      record.fundingSource !== undefined ||
      record.terminalStatus !== undefined ||
      record.terminalAt !== undefined ||
      record.quoteBinding.recipientType !== undefined ||
      record.quoteBinding.fundingSource !== undefined ||
      record.quoteBinding.userAction !== undefined
    ) {
      throw new Error('Stored native ZEC Intents quote route is invalid')
    }
  } else if (
    record.recipientType !== 'CONFIDENTIAL_INTENTS' ||
    (record.fundingSource !== 'transparent' && record.fundingSource !== 'shielded') ||
    record.quoteBinding.recipientType !== record.recipientType ||
    record.quoteBinding.fundingSource !== record.fundingSource ||
    (record.quoteBinding.userAction !== undefined && record.quoteBinding.userAction !== 'swap') ||
    (record.fundingSource === 'transparent' && isShieldedRefund(refund.scheme)) ||
    !record.destination.recipient ||
    !isAddress(record.destination.recipient)
  ) {
    throw new Error('Stored native ZEC Intents confidential quote route is invalid')
  }
  return Object.freeze(record)
}

export async function readNativeZecIntentsSwapMetadata(
  binding: QuoteBinding
): Promise<NativeZecIntentsSwapRecord | null> {
  if (binding.provider !== 'near-intents' || !binding.quoteHandle) return null
  const key = recordKey(binding.quoteHandle)
  const value = (await chrome.storage.local.get(key))[key]
  if (value === undefined) return null
  const record = parseRecord(value)
  return sameNativeZecQuoteBinding(binding, record.quoteBinding) ? record : null
}

export async function markNativeZecIntentsSwapTerminal(
  binding: QuoteBinding,
  transactionId: string,
  status: 'SUCCESS' | 'REFUNDED' | 'FAILED'
): Promise<void> {
  if (binding.recipientType !== 'CONFIDENTIAL_INTENTS') return
  if (!binding.quoteHandle || !ID_PATTERN.test(transactionId)) {
    throw new Error('Native ZEC Confidential terminal binding is invalid')
  }
  await withMetadataLock(async () => {
    const key = recordKey(binding.quoteHandle!)
    const value = (await chrome.storage.local.get(key))[key]
    if (value === undefined) throw new Error('Native ZEC Confidential quote is unavailable')
    const record = parseRecord(value)
    if (
      record.schemaVersion !== 2 ||
      record.claimedTransactionId !== transactionId ||
      !sameNativeZecQuoteBinding(binding, record.quoteBinding) ||
      (record.terminalStatus !== undefined && record.terminalStatus !== status)
    ) {
      throw new Error('Native ZEC Confidential terminal status changed')
    }
    if (record.terminalStatus === status) return
    await chrome.storage.local.set({
      [key]: { ...record, terminalStatus: status, terminalAt: Date.now() }
    })
  })
}

export function readNativeZecIntentsStatusViewer(
  binding: QuoteBinding,
  network: Network
): OneClickViewer | undefined {
  if (binding.provider !== 'near-intents' || !binding.depositAddress || !binding.refundTo) return
  if (binding.oneClickOrder !== undefined) {
    assertNativeZecOrder(
      binding.oneClickOrder,
      binding.depositAddress,
      binding.refundTo,
      network,
      getConfidentialOrderRecipient(binding)
    )
    return binding.oneClickOrder.viewer
  }
  const refund = parseZcashAddress(binding.refundTo, network)
  if (refund.scheme === 'zcash-transparent-p2pkh') {
    return { chainFamily: 'zcash', walletAddress: refund.address, signingMode: 'transparent' }
  }
}

export async function readNativeZecIntentsSwapStatus(
  binding: QuoteBinding,
  scope: NativeZecAccountScope & { readonly signal?: AbortSignal }
): Promise<SwapStatus | null> {
  if (binding.provider !== 'near-intents' || !binding.depositAddress || !binding.refundTo) {
    return null
  }
  const key = binding.quoteHandle ? recordKey(binding.quoteHandle) : undefined
  const value = key ? (await chrome.storage.local.get(key))[key] : undefined
  const record = value === undefined ? undefined : parseRecord(value)
  if (
    record &&
    (record.network !== scope.network ||
      record.walletId !== scope.walletId ||
      record.accountId !== scope.accountId ||
      !sameNativeZecQuoteBinding(binding, record.quoteBinding))
  ) {
    throw new Error('Native ZEC Intents status quote binding changed')
  }
  const viewer = readNativeZecIntentsStatusViewer(binding, scope.network)
  if (!viewer) return null
  const order = createOneClickOrder(
    binding.depositAddress,
    binding.oneClickOrder?.depositMemo,
    viewer
  )
  const status = await queryOneClickOrderStatus({ ...scope, order })
  return status === null ? null : parseSwapStatusResponse(status, record?.destinationDecimals)
}

function assertRecipient(recipient: string, chainId: string, network: Network): void {
  const chain = parseChainId(chainId)
  if (chain.namespace === 'eip155') {
    if (!isAddress(recipient) || /^0x0{40}$/i.test(recipient))
      throw new Error('Swap recipient is invalid')
  } else if (chain.namespace === 'near') {
    parseNearAccountId(recipient)
  } else if (chain.namespace === 'solana') {
    parseSolanaPublicKey(recipient)
  } else if (chainId === getZcashChainId(network)) {
    parseZcashAddress(recipient, network)
  } else {
    throw new Error('Swap destination chain is unsupported')
  }
}

export class NativeZecIntentsSwapCoordinator {
  private readonly prepareQueue = new SerialTaskQueue()

  constructor(
    private readonly options: Readonly<{
      network: Network
      assets: AssetRegistry
      evmNetworks: readonly EvmNetworkConfig[]
      assetMappings: readonly Readonly<{ assetId: string; protocolAssetId: string }>[]
      isUnlocked?: () => Promise<boolean>
      getActiveAccount?: () => NativeZecActiveAccountSnapshot
      resolveOneClickViewer?: typeof resolveZcashOneClickViewer
      resolveConfidentialIdentity?: (
        scope: Readonly<{ walletId: string; accountId: string }>
      ) => Promise<string>
      authorizeConfidentialIdentity?: (
        scope: Readonly<{ walletId: string; accountId: string; recipient: string }>
      ) => Promise<void>
      resolveHardwareConfidentialViewer?: (
        scope: Readonly<{ walletId: string; accountId: string; recipient: string }>
      ) => Promise<OneClickViewer | undefined>
      quoteConfidential?: (
        input: Readonly<{
          referral: typeof NOIR_SWAP_REFERRAL | typeof NOIR_RECEIVE_REFERRAL
          originAsset: string
          destinationAsset: string
          amountRaw: string
          signerId: string
          refundTo: string
          slippageBps: number
          viewer: OneClickViewer | null
        }>
      ) => Promise<ConfidentialQuote>
    }>
  ) {}

  private async read(quoteId: string): Promise<NativeZecIntentsSwapRecord | null> {
    const key = recordKey(quoteId)
    const value = (await chrome.storage.local.get(key))[key]
    return value === undefined ? null : parseRecord(value)
  }

  private async list(): Promise<readonly NativeZecIntentsSwapRecord[]> {
    const ids = await this.readIndex()
    if (ids.length === 0) return []
    const values = await chrome.storage.local.get(ids.map(recordKey))
    return ids.flatMap(id => {
      try {
        return [parseRecord(values[recordKey(id)])]
      } catch {
        return []
      }
    })
  }

  private async readIndex(): Promise<readonly string[]> {
    const value = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY]
    if (value === undefined) return []
    if (
      !Array.isArray(value) ||
      value.length > MAX_STORED_QUOTES ||
      value.some(id => typeof id !== 'string' || !ID_PATTERN.test(id)) ||
      new Set(value).size !== value.length
    ) {
      throw new Error('Stored native ZEC Intents quote index is invalid')
    }
    return value
  }

  private async assertUnlocked(): Promise<void> {
    if (!(await (this.options.isUnlocked ?? (() => credentialSession.hasUnlockSession()))())) {
      throw new Error('Wallet is locked')
    }
  }

  private async pruneExpiredQuotes(): Promise<number> {
    return withMetadataLock(async () => {
      const ids = await this.readIndex()
      if (ids.length === 0) return 0
      const values = await chrome.storage.local.get(ids.map(recordKey))
      const stale = ids.filter(id => {
        try {
          const record = parseRecord(values[recordKey(id)])
          if (record.schemaVersion === 2 && record.claimedTransactionId && !record.terminalAt)
            return false
          return (
            Math.max(record.expiresAt, record.terminalAt ?? 0) + EXPIRED_QUOTE_RETENTION_MS <
            Date.now()
          )
        } catch {
          return true
        }
      })
      if (stale.length > 0) {
        await chrome.storage.local.remove(stale.map(recordKey))
        await chrome.storage.local.set({ [INDEX_KEY]: ids.filter(id => !stale.includes(id)) })
      }
      return ids.length - stale.length
    })
  }

  private assertActiveAccount(walletId: string, accountId: string, refundAddress: string): void {
    const state = this.options.getActiveAccount?.()
    if (
      !state ||
      state.network !== this.options.network ||
      state.walletId !== walletId ||
      state.accountId !== accountId
    ) {
      throw new Error('Native ZEC Intents Swap account changed')
    }
    if (
      !state.refundAddresses.includes(refundAddress) &&
      !(
        isShieldedRefund(parseZcashAddress(refundAddress, state.network).scheme) &&
        state.shieldedRefundAddressHistory?.includes(refundAddress)
      )
    ) {
      throw new Error('Native ZEC Intents refund address is not owned by this account')
    }
  }

  async prepare(input: PrepareNativeZecIntentsSwapInput): Promise<NativeZecIntentsSwapReview> {
    return this.prepareQueue.run(async () => {
      if (
        input.network !== 'mainnet' ||
        input.network !== this.options.network ||
        !ID_PATTERN.test(input.walletId) ||
        !ID_PATTERN.test(input.accountId) ||
        !AMOUNT_PATTERN.test(input.amountZats) ||
        !Number.isSafeInteger(input.slippageBps) ||
        input.slippageBps < 0 ||
        input.slippageBps > 10_000 ||
        (input.requestId !== undefined && !ID_PATTERN.test(input.requestId))
      ) {
        throw new Error('Native ZEC Intents Swap request is invalid')
      }
      const refund = parseZcashAddress(input.refundAddress, input.network)
      const shieldedRefund = isShieldedRefund(refund.scheme)
      const confidential = input.recipientType === 'CONFIDENTIAL_INTENTS'
      if (
        (input.userAction !== undefined && (!confidential || input.userAction !== 'swap')) ||
        (input.recipientType !== undefined &&
          input.recipientType !== 'DESTINATION_CHAIN' &&
          !confidential) ||
        (confidential &&
          (input.destination.recipient !== undefined ||
            (input.fundingSource !== 'transparent' && input.fundingSource !== 'shielded') ||
            (input.fundingSource === 'transparent' && shieldedRefund))) ||
        (!confidential && input.fundingSource !== undefined && input.fundingSource !== 'shielded')
      )
        throw new Error('Native ZEC Intents Swap route is invalid')
      await this.assertUnlocked()
      this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
      const storedQuoteCount = await this.pruneExpiredQuotes()
      const sourceAssetId = `${getZcashChainId(input.network)}/slip44:133`
      if (!this.options.assets.get(sourceAssetId))
        throw new Error('Native ZEC asset is unavailable')
      const confidentialZecDestination =
        confidential &&
        input.destination.chainId === getZcashChainId(input.network) &&
        input.destination.assetId === sourceAssetId &&
        input.destination.protocolAssetId === ZEC_ZCASH_ASSET
      if (
        parseAssetId(input.destination.assetId).chainId !== input.destination.chainId ||
        (input.destination.protocolAssetId === ZEC_ZCASH_ASSET && !confidentialZecDestination)
      ) {
        throw new Error('Native ZEC Intents destination is invalid')
      }
      const confidentialRecipient = confidential
        ? await this.options.resolveConfidentialIdentity?.({
            walletId: input.walletId,
            accountId: input.accountId
          })
        : undefined
      if (confidential && (!confidentialRecipient || !isAddress(confidentialRecipient))) {
        throw new Error('Native ZEC Confidential identity is unavailable')
      }
      const recipient = confidential ? confidentialRecipient! : input.destination.recipient
      if (!recipient) throw new Error('Native ZEC Intents recipient is missing')
      if (!confidential) assertRecipient(recipient, input.destination.chainId, input.network)
      const destination = { ...input.destination, recipient }
      const previous = input.requestId
        ? (await this.list()).find(
            record =>
              record.network === input.network &&
              record.walletId === input.walletId &&
              record.accountId === input.accountId &&
              record.requestId === input.requestId
          )
        : undefined
      if (previous) {
        if (previous.claimedTransactionId) {
          throw new Error('Native ZEC Intents quote was already submitted')
        }
        if (
          previous.amountZats !== input.amountZats ||
          previous.destination.chainId !== input.destination.chainId ||
          previous.destination.assetId !== input.destination.assetId ||
          previous.destination.protocolAssetId !== input.destination.protocolAssetId ||
          previous.destination.recipient !== recipient ||
          (previous.recipientType === 'CONFIDENTIAL_INTENTS') !== confidential ||
          previous.fundingSource !== (confidential ? input.fundingSource : undefined) ||
          previous.quoteBinding.userAction !== input.userAction ||
          previous.refundAddress !== input.refundAddress ||
          previous.slippageBps !== input.slippageBps
        ) {
          throw new Error('Native ZEC Intents request ID was reused with different details')
        }
        if (previous.expiresAt <= Date.now()) throw new Error('Native ZEC Intents quote expired')
        return previous
      }
      if (storedQuoteCount >= MAX_STORED_QUOTES) {
        throw new Error('Too many recent Intents Swap quotes')
      }
      const tokens = await refreshSwapTokenCatalog()
      const sourceToken = tokens.find(candidate => candidate.assetId === ZEC_ZCASH_ASSET)
      if (
        !sourceToken ||
        !['zec', 'zcash'].includes(sourceToken.blockchain.toLowerCase()) ||
        sourceToken.decimals !== 8
      ) {
        throw new Error('Native ZEC Intents source asset catalog changed')
      }
      const token = tokens.find(
        candidate => candidate.assetId === input.destination.protocolAssetId
      )
      const blockchain = token?.blockchain.trim().toLowerCase()
      const tokenChainId =
        blockchain === 'near'
          ? getNearNetworkConfig(input.network).chainId
          : blockchain === 'sol'
            ? getSolanaNetworkConfig(input.network).chainId
            : blockchain === 'zec' || blockchain === 'zcash'
              ? getZcashChainId(input.network)
              : token
                ? resolveIntentsEvmChainId(token.blockchain, this.options.evmNetworks)
                : null
      const asset = this.options.assets.get(input.destination.assetId)
      const managed = token
        ? (resolveManagedIntentsAsset(
            tokens,
            token.assetId,
            input.network,
            this.options.evmNetworks
          ) ?? resolveIntentsWalletAsset(token, input.network))
        : null
      if (
        !token ||
        !asset ||
        (confidential &&
          parseChainId(input.destination.chainId).namespace !== 'eip155' &&
          !confidentialZecDestination) ||
        tokenChainId !== input.destination.chainId ||
        token.decimals !== asset.metadata.decimals ||
        !(
          (managed?.assetId === input.destination.assetId &&
            managed.chainId === input.destination.chainId) ||
          this.options.assetMappings.some(
            mapping =>
              mapping.assetId === input.destination.assetId &&
              mapping.protocolAssetId === input.destination.protocolAssetId
          )
        )
      ) {
        throw new Error('Native ZEC Intents asset catalog changed')
      }
      const refundSource: FundingSource = shieldedRefund ? 'shielded' : 'transparent'
      const resolveViewer = this.options.resolveOneClickViewer ?? resolveZcashOneClickViewer
      const scope = { network: input.network, walletId: input.walletId, accountId: input.accountId }
      const hardwareViewer = confidential
        ? await this.options.resolveHardwareConfidentialViewer?.({ ...scope, recipient })
        : undefined
      if (
        hardwareViewer &&
        (input.userAction !== 'swap' ||
          !confidentialZecDestination ||
          refund.scheme !== 'zcash-transparent-p2pkh')
      ) {
        throw new Error('Ledger Confidential swap requires a transparent ZEC refund address')
      }
      const viewer =
        hardwareViewer ?? (await resolveViewer(scope, input.refundAddress, refundSource))
      this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
      const confidentialQuote = confidential
        ? await this.options.quoteConfidential?.({
            referral: input.userAction === 'swap' ? NOIR_SWAP_REFERRAL : NOIR_RECEIVE_REFERRAL,
            originAsset: ZEC_ZCASH_ASSET,
            destinationAsset: input.destination.protocolAssetId,
            amountRaw: input.amountZats,
            signerId: recipient,
            refundTo: input.refundAddress,
            slippageBps: input.slippageBps,
            viewer: viewer ?? null
          })
        : undefined
      if (confidential && !confidentialQuote)
        throw new Error('Native ZEC Confidential quote is unavailable')
      if (confidentialQuote)
        assertConfidentialQuoteBinding(confidentialQuote, {
          originAsset: ZEC_ZCASH_ASSET,
          destinationAsset: input.destination.protocolAssetId,
          amountRaw: input.amountZats,
          signerId: recipient,
          refundTo: input.refundAddress,
          recipient,
          depositType: 'ORIGIN_CHAIN',
          refundType: 'ORIGIN_CHAIN',
          recipientType: 'CONFIDENTIAL_INTENTS',
          slippageBps: input.slippageBps
        })
      const result = confidential
        ? null
        : await fetchQuote({
            originAsset: ZEC_ZCASH_ASSET,
            destinationAsset: input.destination.protocolAssetId,
            amount: input.amountZats,
            refundTo: input.refundAddress,
            recipient,
            slippageTolerance: input.slippageBps,
            validateQuoteRequest: true,
            viewer: viewer ?? null
          })
      const quote = confidentialQuote?.quote ?? result?.quoteSuccessResult?.quote
      if (!quote || (!confidential && result?.quoteStatus !== 'success')) {
        throw new Error(result?.message ?? 'Native ZEC Intents quote is unavailable')
      }
      const appFeeBps = confidentialQuote
        ? readConfidentialQuoteAppFees(confidentialQuote).reduce((total, fee) => total + fee.fee, 0)
        : undefined
      const expiresAt = Date.parse(quote.deadline)
      if (
        quote.amountIn !== input.amountZats ||
        !AMOUNT_PATTERN.test(quote.amountOut) ||
        !AMOUNT_PATTERN.test(quote.minAmountOut) ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        throw new Error('Native ZEC Intents quote changed its amount or deadline')
      }
      const deposit = parseZcashAddress(quote.depositAddress, input.network)
      if (
        confidential &&
        input.fundingSource === 'transparent' &&
        !deposit.scheme.startsWith('zcash-transparent-')
      ) {
        throw new Error('Native ZEC Confidential quote requires a transparent deposit address')
      }
      if (hardwareViewer && quote.depositMemo !== undefined) {
        throw new Error('Ledger Confidential swap requires a deposit without a memo')
      }
      if ((await this.list()).some(record => record.depositAddress === quote.depositAddress)) {
        throw new Error('Native ZEC Intents deposit address was reused')
      }
      if (confidential && !hardwareViewer) {
        if (!this.options.authorizeConfidentialIdentity) {
          throw new Error('Native ZEC Confidential authorization is unavailable')
        }
        await this.options.authorizeConfidentialIdentity({
          walletId: input.walletId,
          accountId: input.accountId,
          recipient
        })
      }
      this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
      const confirmedRecipient = confidential
        ? await this.options.resolveConfidentialIdentity?.({
            walletId: input.walletId,
            accountId: input.accountId
          })
        : undefined
      this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
      if (confidential && confirmedRecipient !== recipient) {
        throw new Error('Native ZEC Confidential account changed after quoting')
      }
      const quoteId = crypto.randomUUID()
      const oneClickOrder = createOneClickOrder(quote.depositAddress, quote.depositMemo, viewer)
      assertNativeZecOrder(
        oneClickOrder,
        quote.depositAddress,
        input.refundAddress,
        input.network,
        hardwareViewer ? recipient : undefined
      )
      const quoteBinding: QuoteBinding = Object.freeze({
        provider: 'near-intents',
        ...(input.userAction ? { userAction: input.userAction } : {}),
        quoteHandle: quoteId,
        isCrossChain: true,
        destinationChain: input.destination.chainId,
        depositAddress: quote.depositAddress,
        oneClickOrder,
        originAsset: ZEC_ZCASH_ASSET,
        destinationAsset: input.destination.protocolAssetId,
        expectedAmountOut: quote.amountOut,
        minAmountOut: quote.minAmountOut,
        recipient,
        ...(confidential
          ? { recipientType: 'CONFIDENTIAL_INTENTS' as const, fundingSource: input.fundingSource }
          : {}),
        refundTo: input.refundAddress,
        deadline: expiresAt
      })
      const record: NativeZecIntentsSwapRecord = Object.freeze({
        schemaVersion: confidential ? 2 : 1,
        quoteId,
        network: input.network,
        walletId: input.walletId,
        accountId: input.accountId,
        amountZats: input.amountZats,
        amountZec: zatsToZec(input.amountZats),
        depositAddress: quote.depositAddress,
        destination,
        destinationBlockchain: token.blockchain,
        destinationSymbol: token.symbol,
        destinationDecimals: token.decimals,
        refundAddress: input.refundAddress,
        ...(confidential
          ? { recipientType: 'CONFIDENTIAL_INTENTS' as const, fundingSource: input.fundingSource }
          : {}),
        expectedOutputRaw: quote.amountOut,
        minimumOutputRaw: quote.minAmountOut,
        ...(appFeeBps === undefined ? {} : { appFeeBps }),
        expiresAt,
        quoteBinding,
        slippageBps: input.slippageBps,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        createdAt: Date.now()
      })
      await withUndeletedWalletAccountMetadata(
        input.walletId,
        input.accountId,
        input.network,
        async () => {
          const ids = await this.readIndex()
          this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
          if (ids.length >= MAX_STORED_QUOTES) {
            throw new Error('Too many recent Intents Swap quotes')
          }
          await chrome.storage.local.set({
            [recordKey(quoteId)]: record,
            [INDEX_KEY]: [...ids, quoteId]
          })
        }
      )
      this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
      return record
    })
  }

  async get(quoteId: string): Promise<NativeZecIntentsSwapReview> {
    await this.assertUnlocked()
    const record = await this.read(quoteId)
    if (!record) throw new Error('Native ZEC Intents quote is unavailable')
    this.assertActiveAccount(record.walletId, record.accountId, record.refundAddress)
    return record
  }

  async cancel(quoteId: string): Promise<boolean> {
    await this.assertUnlocked()
    const active = this.options.getActiveAccount?.()
    if (!active?.walletId || !active.accountId || active.network !== this.options.network) {
      throw new Error('Native ZEC Intents Swap account changed')
    }
    return withUndeletedWalletAccountMetadata(
      active.walletId,
      active.accountId,
      this.options.network,
      async () => {
        const record = await this.read(quoteId)
        if (!record || record.claimedTransactionId) return false
        this.assertActiveAccount(record.walletId, record.accountId, record.refundAddress)
        await chrome.storage.local.remove(recordKey(quoteId))
        const ids = await this.readIndex()
        await chrome.storage.local.set({ [INDEX_KEY]: ids.filter(id => id !== quoteId) })
        return true
      }
    )
  }

  async claimSpend(
    input: Readonly<{
      walletId: string
      accountId: string
      transactionId: string
      binding: QuoteBinding
      to: string
      amount: string
      fundingSource: string
    }>
  ): Promise<number> {
    await this.assertUnlocked()
    if (input.binding.provider !== 'near-intents' || !input.binding.quoteHandle) {
      throw new Error('Native ZEC Intents quote is missing')
    }
    const quoteId = input.binding.quoteHandle
    return withUndeletedWalletAccountMetadata(
      input.walletId,
      input.accountId,
      this.options.network,
      async () => {
        const record = await this.read(quoteId)
        if (
          !record ||
          record.walletId !== input.walletId ||
          record.accountId !== input.accountId ||
          record.network !== this.options.network ||
          (record.claimedTransactionId !== undefined &&
            record.claimedTransactionId !== input.transactionId) ||
          record.expiresAt <= Date.now() ||
          input.fundingSource !==
            (record.schemaVersion === 2 ? record.fundingSource : 'shielded') ||
          input.to !== record.depositAddress ||
          zecToZats(input.amount) !== record.amountZats ||
          !sameNativeZecQuoteBinding(input.binding, record.quoteBinding)
        ) {
          throw new Error('Native ZEC Intents quote changed or was already submitted')
        }
        this.assertActiveAccount(input.walletId, input.accountId, record.refundAddress)
        if (
          record.schemaVersion === 2 &&
          (await this.options.resolveConfidentialIdentity?.({
            walletId: input.walletId,
            accountId: input.accountId
          })) !== record.destination.recipient
        ) {
          throw new Error('Native ZEC Confidential account changed before submission')
        }
        if (record.claimedTransactionId === input.transactionId) return record.expiresAt
        await chrome.storage.local.set({
          [recordKey(quoteId)]: { ...record, claimedTransactionId: input.transactionId }
        })
        return record.expiresAt
      }
    )
  }
}
