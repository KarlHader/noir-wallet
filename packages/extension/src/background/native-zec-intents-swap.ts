import { isAddress } from 'viem'
import type { AssetRegistry } from '@/core/chains/registry'
import { getZcashChainId, parseAssetId, parseChainId } from '@/core/chains/registry'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { parseNearAccountId } from '@/core/chains/near'
import { parseSolanaPublicKey } from '@/core/chains/solana'
import { ZEC_ZCASH_ASSET } from '@/config/intents'
import type { EvmNetworkConfig } from '@/config/networks'
import { getNearNetworkConfig, getSolanaNetworkConfig } from '@/config/networks'
import { fetchQuote, refreshSwapTokenCatalog } from '@/core/services/intents-api'
import { resolveManagedIntentsAsset } from '@/core/services/intents-managed-assets'
import { resolveIntentsEvmChainId } from '@/core/services/intents-evm-assets'
import { resolveIntentsWalletAsset } from '@/core/services/intents-wallet-assets'
import {
  zatsToZec,
  zecToZats,
  type NativeZecIntentsSwapRecord,
  type NativeZecIntentsSwapReview,
  type PrepareNativeZecIntentsSwapInput
} from '@/core/services/native-zec-intents-swap'
import { SerialTaskQueue } from '@/lib/async-utils'
import { withUndeletedWalletAccountMetadata } from '@/lib/wallet-metadata-storage'
import { withMetadataLock } from '@/lib/wallet-metadata-storage'
import { credentialSession } from './credential-session'
import type { Network, QuoteBinding } from '@/types/wallet'

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
}

function recordKey(quoteId: string): string {
  if (!ID_PATTERN.test(quoteId)) throw new Error('Native ZEC Intents quote ID is invalid')
  return `${PREFIX}${quoteId}`
}

function sameBinding(left: QuoteBinding, right: QuoteBinding): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    left.provider === right.provider &&
    left.quoteHandle === right.quoteHandle &&
    left.isCrossChain === right.isCrossChain &&
    left.destinationChain === right.destinationChain &&
    left.depositAddress === right.depositAddress &&
    left.originAsset === right.originAsset &&
    left.destinationAsset === right.destinationAsset &&
    left.expectedAmountOut === right.expectedAmountOut &&
    left.minAmountOut === right.minAmountOut &&
    left.recipient === right.recipient &&
    left.refundTo === right.refundTo &&
    left.deadline === right.deadline
  )
}

function parseRecord(value: unknown): NativeZecIntentsSwapRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored native ZEC Intents quote is invalid')
  }
  const record = value as NativeZecIntentsSwapRecord
  if (
    record.schemaVersion !== 1 ||
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
    !AMOUNT_PATTERN.test(record.expectedOutputRaw) ||
    !AMOUNT_PATTERN.test(record.minimumOutputRaw) ||
    BigInt(record.minimumOutputRaw) > BigInt(record.expectedOutputRaw) ||
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
  parseZcashAddress(record.refundAddress, record.network)
  parseAssetId(record.destination.assetId)
  parseChainId(record.destination.chainId)
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
  return sameBinding(binding, record.quoteBinding) ? record : null
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
          return (
            parseRecord(values[recordKey(id)]).expiresAt + EXPIRED_QUOTE_RETENTION_MS < Date.now()
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
    if (!state.refundAddresses.includes(refundAddress)) {
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
      parseZcashAddress(input.refundAddress, input.network)
      await this.assertUnlocked()
      this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
      const storedQuoteCount = await this.pruneExpiredQuotes()
      const sourceAssetId = `${getZcashChainId(input.network)}/slip44:133`
      if (!this.options.assets.get(sourceAssetId))
        throw new Error('Native ZEC asset is unavailable')
      if (
        parseAssetId(input.destination.assetId).chainId !== input.destination.chainId ||
        input.destination.protocolAssetId === ZEC_ZCASH_ASSET
      ) {
        throw new Error('Native ZEC Intents destination is invalid')
      }
      assertRecipient(input.destination.recipient, input.destination.chainId, input.network)
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
          previous.destination.recipient !== input.destination.recipient ||
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
      const result = await fetchQuote({
        originAsset: ZEC_ZCASH_ASSET,
        destinationAsset: input.destination.protocolAssetId,
        amount: input.amountZats,
        refundTo: input.refundAddress,
        recipient: input.destination.recipient,
        slippageTolerance: input.slippageBps,
        validateQuoteRequest: true
      })
      const quote = result.quoteSuccessResult?.quote
      if (!quote || result.quoteStatus !== 'success') {
        throw new Error(result.message ?? 'Native ZEC Intents quote is unavailable')
      }
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
      parseZcashAddress(quote.depositAddress, input.network)
      if ((await this.list()).some(record => record.depositAddress === quote.depositAddress)) {
        throw new Error('Native ZEC Intents deposit address was reused')
      }
      this.assertActiveAccount(input.walletId, input.accountId, input.refundAddress)
      const quoteId = crypto.randomUUID()
      const quoteBinding: QuoteBinding = Object.freeze({
        provider: 'near-intents',
        quoteHandle: quoteId,
        isCrossChain: true,
        destinationChain: input.destination.chainId,
        depositAddress: quote.depositAddress,
        originAsset: ZEC_ZCASH_ASSET,
        destinationAsset: input.destination.protocolAssetId,
        expectedAmountOut: quote.amountOut,
        minAmountOut: quote.minAmountOut,
        recipient: input.destination.recipient,
        refundTo: input.refundAddress,
        deadline: expiresAt
      })
      const record: NativeZecIntentsSwapRecord = Object.freeze({
        schemaVersion: 1,
        quoteId,
        network: input.network,
        walletId: input.walletId,
        accountId: input.accountId,
        amountZats: input.amountZats,
        amountZec: zatsToZec(input.amountZats),
        depositAddress: quote.depositAddress,
        destination: input.destination,
        destinationBlockchain: token.blockchain,
        destinationSymbol: token.symbol,
        destinationDecimals: token.decimals,
        refundAddress: input.refundAddress,
        expectedOutputRaw: quote.amountOut,
        minimumOutputRaw: quote.minAmountOut,
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
          if (ids.length >= MAX_STORED_QUOTES) {
            throw new Error('Too many recent Intents Swap quotes')
          }
          await chrome.storage.local.set({
            [recordKey(quoteId)]: record,
            [INDEX_KEY]: [...ids, quoteId]
          })
        }
      )
      return record
    })
  }

  async get(quoteId: string): Promise<NativeZecIntentsSwapReview> {
    await this.assertUnlocked()
    const record = await this.read(quoteId)
    if (!record) throw new Error('Native ZEC Intents quote is unavailable')
    if (record.claimedTransactionId) {
      throw new Error('Native ZEC Intents quote was already submitted')
    }
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
          record.claimedTransactionId ||
          record.expiresAt <= Date.now() ||
          input.fundingSource !== 'shielded' ||
          input.to !== record.depositAddress ||
          zecToZats(input.amount) !== record.amountZats ||
          !sameBinding(input.binding, record.quoteBinding)
        ) {
          throw new Error('Native ZEC Intents quote changed or was already submitted')
        }
        this.assertActiveAccount(input.walletId, input.accountId, record.refundAddress)
        await chrome.storage.local.set({
          [recordKey(quoteId)]: { ...record, claimedTransactionId: input.transactionId }
        })
        return record.expiresAt
      }
    )
  }
}
