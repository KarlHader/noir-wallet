import { ZEC_DECIMALS } from '../../config/wallet.ts'
import { safeBig } from '../../lib/big.ts'
import { formatBaseUnitDecimalAmount } from '../../lib/number-format.ts'
import { isTransparentZcashAddress } from '../../lib/zcash-memo.ts'
import {
  getAddressTxids,
  getVerboseTransaction,
  mapWithConcurrency,
  type VerboseTransaction,
  type VerboseTxOutput
} from '../../lib/zcash-node-rpc.ts'
import { loadTransparentTxCache, saveTransparentTxCache } from '../../lib/indexed-db.ts'
import type { AccountData, Network, Transaction } from '../../types/wallet.ts'
import { partitionVerboseTransactions } from './transparent-history-cache.ts'
import {
  getRequiredConfirmations,
  mergeTransactionUpdate,
  synchronizeInternalTransferConfirmations,
  type ConfirmationTrust,
  type ZcashConfirmation
} from '../../lib/transaction-status.ts'
import {
  isDuplicateWasmRow,
  isTransparentReceive,
  localShieldedSendHashSet,
  localTxHashSet,
  normalizeTxHash
} from '../../lib/tx-history-dedup.ts'

const MAX_RECENT_TXS = 100
const FETCH_CONCURRENCY = 5
const HISTORY_CACHE_TTL_MS = 30_000
const ZATOSHIS_PER_ZEC = 10n ** BigInt(ZEC_DECIMALS)

const transparentHistoryInFlight = new Map<string, Promise<Transaction[]>>()
const transparentHistoryCache = new Map<
  string,
  { timestamp: number; transactions: Transaction[] }
>()

async function fetchVerboseTransactions(
  txids: readonly string[],
  baseUrl: string,
  target: Map<string, VerboseTransaction>,
  signal?: AbortSignal
): Promise<Set<string>> {
  const failed = new Set<string>()
  await mapWithConcurrency(txids, FETCH_CONCURRENCY, async txid => {
    try {
      signal?.throwIfAborted()
      const transaction = await getVerboseTransaction(baseUrl, txid, signal)
      if (normalizeTxHash(transaction?.txid) !== normalizeTxHash(txid)) {
        failed.add(txid)
        return
      }
      target.set(txid, transaction)
    } catch {
      failed.add(txid)
    }
  })
  return failed
}

function outputValueToAddress(output: VerboseTxOutput | undefined, address: string): bigint {
  if (!output?.scriptPubKey?.addresses?.includes(address)) return 0n
  return BigInt(output.valueZat ?? 0)
}

/**
 * Net zatoshis the address gained in a transaction: outputs paying the address
 * minus inputs spending the address's own UTXOs (resolved via prevout txs),
 * so send-with-change transactions are not misread as receives.
 */
export function computeNetReceivedZatoshis(
  tx: VerboseTransaction,
  prevoutTxs: ReadonlyMap<string, VerboseTransaction>,
  address: string
): bigint {
  const received = (tx.vout ?? []).reduce(
    (sum, output) => sum + outputValueToAddress(output, address),
    0n
  )
  const spent = (tx.vin ?? []).reduce((sum, input) => {
    if (!input.txid || input.vout == null) return sum
    const prevout = prevoutTxs.get(input.txid)?.vout?.[input.vout]
    return sum + outputValueToAddress(prevout, address)
  }, 0n)

  return received - spent
}

export function mapVerboseTransactionToReceive(
  tx: VerboseTransaction,
  prevoutTxs: ReadonlyMap<string, VerboseTransaction>,
  account: AccountData,
  network: Network,
  trust: ConfirmationTrust = 'untrusted',
  confirmationHint = 0
): Transaction | null {
  const address = account.addresses.transparent
  if (!address || !tx.txid) return null

  const amount = computeNetReceivedZatoshis(tx, prevoutTxs, address)
  if (amount <= 0n) return null

  const blockTimeSec = tx.blocktime ?? tx.time
  const confirmations = Math.max(0, tx.confirmations ?? 0, confirmationHint)
  const requiredConfirmations = getRequiredConfirmations('receive', trust)

  return {
    id: `rpc_treceive_${tx.txid}`,
    txHash: tx.txid,
    status:
      confirmations === 0
        ? 'pending'
        : confirmations >= requiredConfirmations
          ? 'success'
          : 'confirming',
    confirmations,
    requiredConfirmations,
    type: 'receive',
    amount: formatBaseUnitDecimalAmount(amount, ZEC_DECIMALS),
    to: address,
    from: '',
    fromType: 'transparent',
    fee: '0',
    timestamp: blockTimeSec ? blockTimeSec * 1000 : Date.now(),
    network
  }
}

async function fetchTransparentReceiveTransactionsUncached(
  account: AccountData,
  network: Network,
  baseUrl: string,
  cacheKey?: string,
  walletCreatedTxids: ReadonlySet<string> = new Set(),
  confirmationHints: ReadonlyMap<string, number> = new Map()
): Promise<Transaction[]> {
  const address = account.addresses.transparent
  if (!address) return []

  // The wallet's own address cannot have activity before the wallet birthday,
  // so bound the node-side index scan with it.
  const txids = await getAddressTxids(baseUrl, address, account.birthdayHeight)
  if (txids.length === 0) return []

  // Any input spending this address's UTXO references a funding tx that is
  // itself part of the address history, so this set is enough to decide
  // which prevouts must be resolved.
  const historyTxids = new Set(txids)
  const candidateTxids = txids.slice(-MAX_RECENT_TXS)
  if (candidateTxids.length === 0) return []

  const persistedCache = cacheKey ? await loadTransparentTxCache(cacheKey) : {}
  const trustedTxids = candidateTxids.filter(txid => walletCreatedTxids.has(normalizeTxHash(txid)))
  const untrustedTxids = candidateTxids.filter(
    txid => !walletCreatedTxids.has(normalizeTxHash(txid))
  )
  const trusted = partitionVerboseTransactions(
    trustedTxids,
    persistedCache,
    getRequiredConfirmations('receive', 'trusted')
  )
  const untrusted = partitionVerboseTransactions(
    untrustedTxids,
    persistedCache,
    getRequiredConfirmations('receive', 'untrusted')
  )
  const txByTxid = new Map([...trusted.reusable, ...untrusted.reusable])

  const persistFetchedTransactions = async () => {
    if (!cacheKey) return
    await saveTransparentTxCache(cacheKey, txByTxid).catch(error => {
      console.warn('[TransparentHistory] Failed to persist transaction cache:', error)
    })
  }

  const recentFailures = await fetchVerboseTransactions(
    [...trusted.txidsToFetch, ...untrusted.txidsToFetch],
    baseUrl,
    txByTxid
  )
  await persistFetchedTransactions()

  const missingPrevouts = new Set<string>()
  for (const txid of candidateTxids) {
    for (const input of txByTxid.get(txid)?.vin ?? []) {
      if (input.txid && historyTxids.has(input.txid) && !txByTxid.has(input.txid)) {
        missingPrevouts.add(input.txid)
      }
    }
  }
  const prevouts = partitionVerboseTransactions([...missingPrevouts], persistedCache)
  prevouts.reusable.forEach((transaction, txid) => txByTxid.set(txid, transaction))
  const prevoutFailures = await fetchVerboseTransactions(prevouts.txidsToFetch, baseUrl, txByTxid)
  await persistFetchedTransactions()
  if (recentFailures.size > 0 || prevoutFailures.size > 0) {
    console.warn(
      '[TransparentHistory] Some transaction details could not be fetched:',
      `${recentFailures.size} transactions, ${prevoutFailures.size} prevouts`
    )
  }

  return candidateTxids
    .map(txid => txByTxid.get(txid))
    .filter((tx): tx is VerboseTransaction => !!tx)
    .filter(tx =>
      (tx.vin ?? []).every(
        input => !input.txid || !historyTxids.has(input.txid) || txByTxid.has(input.txid)
      )
    )
    .map(tx =>
      mapVerboseTransactionToReceive(
        tx,
        txByTxid,
        account,
        network,
        walletCreatedTxids.has(normalizeTxHash(tx.txid)) ? 'trusted' : 'untrusted',
        confirmationHints.get(normalizeTxHash(tx.txid))
      )
    )
    .filter((tx): tx is Transaction => tx !== null)
}

function applyCurrentConfirmationPolicy(
  transactions: readonly Transaction[],
  walletCreatedTxids: ReadonlySet<string>,
  confirmationHints: ReadonlyMap<string, number>
): Transaction[] {
  return transactions.map(transaction => {
    const txHash = normalizeTxHash(transaction.txHash)
    const trust = walletCreatedTxids.has(txHash) ? 'trusted' : 'untrusted'
    const requiredConfirmations = getRequiredConfirmations('receive', trust)
    const confirmations = Math.max(
      0,
      transaction.confirmations ?? 0,
      confirmationHints.get(txHash) ?? 0
    )

    return {
      ...transaction,
      status:
        confirmations === 0
          ? 'pending'
          : confirmations >= requiredConfirmations
            ? 'success'
            : 'confirming',
      confirmations,
      requiredConfirmations
    }
  })
}

export async function fetchTransparentReceiveTransactions(
  account: AccountData,
  network: Network,
  options?: {
    baseUrl?: string
    cacheKey?: string
    walletCreatedTxids?: ReadonlySet<string>
    confirmationHints?: ReadonlyMap<string, number>
  }
): Promise<Transaction[]> {
  const address = account.addresses.transparent
  const baseUrl = options?.baseUrl
  if (!address || !baseUrl) return []

  const requestCacheKey = `${network}:${address}:${baseUrl.replace(/\/+$/, '')}`
  const cached = transparentHistoryCache.get(requestCacheKey)
  const walletCreatedTxids = options?.walletCreatedTxids ?? new Set<string>()
  const confirmationHints = options?.confirmationHints ?? new Map<string, number>()

  if (cached && Date.now() - cached.timestamp < HISTORY_CACHE_TTL_MS) {
    return applyCurrentConfirmationPolicy(
      cached.transactions,
      walletCreatedTxids,
      confirmationHints
    )
  }

  const pending = transparentHistoryInFlight.get(requestCacheKey)
  if (pending) {
    return pending.then(transactions =>
      applyCurrentConfirmationPolicy(transactions, walletCreatedTxids, confirmationHints)
    )
  }

  const request = fetchTransparentReceiveTransactionsUncached(
    account,
    network,
    baseUrl,
    options?.cacheKey,
    walletCreatedTxids,
    confirmationHints
  )
    .then(transactions => {
      transparentHistoryCache.set(requestCacheKey, { timestamp: Date.now(), transactions })
      return transactions
    })
    .finally(() => {
      transparentHistoryInFlight.delete(requestCacheKey)
    })

  transparentHistoryInFlight.set(requestCacheKey, request)
  return request
}

/** Only a single external destination accounting for the sent amount is unambiguous. */
export function getTransparentSendRecipient(
  transaction: VerboseTransaction,
  amount: string,
  ownedAddresses: ReadonlySet<string>
): string | undefined {
  const amountZatoshis = safeBig(amount).times(ZATOSHIS_PER_ZEC.toString())
  if (amountZatoshis.lte(0) || !amountZatoshis.mod(1).eq(0)) return undefined
  if (!Array.isArray(transaction.vout)) return undefined

  const destinations = new Map<string, bigint>()
  for (const output of transaction.vout) {
    const value = output?.valueZat
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
    if (value === 0) continue
    const addresses = output.scriptPubKey?.addresses
    if (
      !Array.isArray(addresses) ||
      addresses.length !== 1 ||
      typeof addresses[0] !== 'string' ||
      !isTransparentZcashAddress(addresses[0])
    ) {
      return undefined
    }
    const address = addresses[0]
    if (ownedAddresses.has(address)) continue
    destinations.set(address, (destinations.get(address) ?? 0n) + BigInt(value))
  }

  if (destinations.size !== 1) return undefined
  const [destination] = destinations
  if (!destination || destination[1] !== BigInt(amountZatoshis.toFixed(0))) return undefined
  return destination[0]
}

export async function fetchMissingTransparentSendRecipients(
  transactions: readonly Transaction[],
  ownedAddresses: ReadonlySet<string>,
  options: { baseUrl: string; cacheKey: string; signal?: AbortSignal }
): Promise<Map<string, string>> {
  const candidates = transactions.filter(
    transaction =>
      transaction.type === 'send' &&
      !transaction.to &&
      /^[0-9a-f]{64}$/.test(normalizeTxHash(transaction.txHash))
  )
  const recipients = new Map<string, string>()
  if (!options.baseUrl || candidates.length === 0) return recipients

  options.signal?.throwIfAborted()
  const txids = [...new Set(candidates.map(transaction => normalizeTxHash(transaction.txHash)))]
  const cached = await loadTransparentTxCache(options.cacheKey)
  options.signal?.throwIfAborted()
  const { reusable, txidsToFetch } = partitionVerboseTransactions(txids, cached)
  await fetchVerboseTransactions(txidsToFetch, options.baseUrl, reusable, options.signal)
  options.signal?.throwIfAborted()
  // Cache confirmed bodies even when the recipient is shielded or ambiguous.
  await saveTransparentTxCache(options.cacheKey, reusable, options.signal).catch(error => {
    if (options.signal?.aborted) throw error
    console.warn('[TransparentHistory] Failed to persist recipient transaction cache:', error)
  })
  options.signal?.throwIfAborted()

  for (const transaction of candidates) {
    const hash = normalizeTxHash(transaction.txHash)
    const verbose = reusable.get(hash)
    if (!verbose || normalizeTxHash(verbose.txid) !== hash) continue
    const recipient = getTransparentSendRecipient(verbose, transaction.amount, ownedAddresses)
    if (recipient) recipients.set(hash, recipient)
  }
  return recipients
}

export function mergeTransactionsWithWasmHistory(
  currentTransactions: Transaction[],
  wasmTransactions: Transaction[],
  transparentReceives: Transaction[]
): { transactions: Transaction[]; newWasmTransactionCount: number } {
  const walletHistoryByHash = new Map<string, Transaction>()
  for (const transaction of wasmTransactions) {
    const hash = normalizeTxHash(transaction.txHash)
    if (hash) walletHistoryByHash.set(hash, transaction)
  }
  const refreshedCurrentTransactions = currentTransactions.map(transaction => {
    if (
      transaction.type !== 'send' &&
      transaction.type !== 'shield' &&
      transaction.type !== 'unshield'
    ) {
      return transaction
    }

    const walletHistory = walletHistoryByHash.get(normalizeTxHash(transaction.txHash))
    if (!walletHistory) return transaction

    const confirmation: ZcashConfirmation | undefined =
      walletHistory.status === 'success' && walletHistory.confirmations != null
        ? { txHash: walletHistory.txHash, confirmations: walletHistory.confirmations }
        : undefined
    return mergeTransactionUpdate(
      transaction,
      {
        status: walletHistory.status,
        confirmations: walletHistory.confirmations,
        requiredConfirmations: walletHistory.requiredConfirmations,
        amount:
          transaction.type === 'shield' && walletHistory.type === 'shield'
            ? safeBig(walletHistory.amount)
                .plus(walletHistory.fee ?? 0)
                .toFixed()
            : transaction.amount
      },
      confirmation
    )
  })
  const currentById = new Map(refreshedCurrentTransactions.map(tx => [tx.id, tx]))
  const reconciledWasmTransactions = wasmTransactions.map(transaction => {
    const current = currentById.get(transaction.id)
    const confirmation: ZcashConfirmation | undefined =
      transaction.status === 'success' && transaction.confirmations != null
        ? { txHash: transaction.txHash, confirmations: transaction.confirmations }
        : undefined
    return current
      ? mergeTransactionUpdate(
          current,
          {
            ...transaction,
            timestamp: transaction.timestamp > 0 ? transaction.timestamp : current.timestamp,
            to: transaction.to || (current.type === transaction.type ? current.to : '')
          },
          confirmation
        )
      : {
          ...transaction,
          timestamp: transaction.timestamp > 0 ? transaction.timestamp : Date.now()
        }
  })
  const localHashes = localTxHashSet(refreshedCurrentTransactions)
  const localShieldedSendHashes = localShieldedSendHashSet(refreshedCurrentTransactions)
  const newWasmTransactions = reconciledWasmTransactions.filter(
    tx => !isDuplicateWasmRow(tx, localHashes, localShieldedSendHashes)
  )
  const newWasmHashes = new Set(newWasmTransactions.map(tx => normalizeTxHash(tx.txHash)))
  const preservedTransactions = refreshedCurrentTransactions.filter(tx => {
    if (isDuplicateWasmRow(tx, localHashes, localShieldedSendHashes)) return false
    if (!tx.id.startsWith('wasm_')) return true
    return !newWasmHashes.has(normalizeTxHash(tx.txHash))
  })
  const mergedWasmTransactions = [...preservedTransactions, ...newWasmTransactions].sort(
    (a, b) => b.timestamp - a.timestamp
  )

  const transactions = mergeTransactionsWithTransparentReceives(
    mergedWasmTransactions,
    transparentReceives,
    localShieldedSendHashes
  )

  return {
    transactions: synchronizeInternalTransferConfirmations(transactions),
    newWasmTransactionCount: newWasmTransactions.length
  }
}

export function mergeTransactionsWithTransparentReceives(
  existingTransactions: Transaction[],
  transparentReceives: Transaction[],
  localShieldedSendHashes: ReadonlySet<string> = localShieldedSendHashSet(existingTransactions)
): Transaction[] {
  if (transparentReceives.length === 0) return existingTransactions

  const existingByHash = new Map(
    existingTransactions
      .filter(isTransparentReceive)
      .map(transaction => [normalizeTxHash(transaction.txHash), transaction])
  )
  const reconciledReceives = transparentReceives.map(transaction => {
    const existing = existingByHash.get(normalizeTxHash(transaction.txHash))
    if (!existing) return transaction
    if (
      (existing.status === 'success' && transaction.status !== 'success') ||
      (existing.status === 'failed' &&
        (transaction.status !== 'success' ||
          !Number.isSafeInteger(transaction.confirmations) ||
          (transaction.confirmations ?? 0) < getRequiredConfirmations('receive')))
    ) {
      return existing
    }
    const refreshed = {
      ...transaction,
      ...(existing.depositAddress ? { depositAddress: existing.depositAddress } : {})
    }
    if (existing.status !== 'failed') return refreshed
    return mergeTransactionUpdate(
      existing,
      { ...refreshed, id: existing.id },
      { txHash: transaction.txHash, confirmations: transaction.confirmations ?? 0 }
    )
  })
  const transparentReceiveHashes = new Set(reconciledReceives.map(tx => normalizeTxHash(tx.txHash)))
  const preservedTransactions = existingTransactions.filter(
    tx => !isTransparentReceive(tx) || !transparentReceiveHashes.has(normalizeTxHash(tx.txHash))
  )

  const externalReceives = reconciledReceives.filter(
    tx => !localShieldedSendHashes.has(normalizeTxHash(tx.txHash))
  )

  return [...preservedTransactions, ...externalReceives].sort((a, b) => b.timestamp - a.timestamp)
}

export function associateIncomingIntentsTransactions(transactions: Transaction[]): Transaction[] {
  const depositsByHash = new Map<string, string | null>()
  for (const entry of transactions) {
    if (entry.type !== 'swap' || !entry.depositAddress) continue
    const hash = entry.destinationTxHash
    if (!hash) continue
    const normalized = normalizeTxHash(hash)
    const existing = depositsByHash.get(normalized)
    depositsByHash.set(
      normalized,
      existing === undefined || existing === entry.depositAddress ? entry.depositAddress : null
    )
  }
  return transactions.map(transaction => {
    if (transaction.type !== 'receive' || transaction.depositAddress) return transaction
    const depositAddress = depositsByHash.get(normalizeTxHash(transaction.txHash))
    return depositAddress ? { ...transaction, depositAddress } : transaction
  })
}
