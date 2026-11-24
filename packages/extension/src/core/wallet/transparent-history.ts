import { ZEC_DECIMALS } from '../../config/wallet.ts'
import { safeBig } from '../../lib/big.ts'
import { formatBaseUnitDecimalAmount } from '../../lib/number-format.ts'
import { isTransparentZcashAddress } from '../../lib/zcash-memo.ts'
import {
  getAddressTxids,
  getVerboseTransaction,
  lookupTransaction,
  mapWithConcurrency,
  type VerboseTransaction,
  type VerboseTxOutput
} from '../../lib/zcash-node-rpc.ts'
import { loadTransparentTxCache, saveTransparentTxCache } from '../../lib/indexed-db.ts'
import type { AccountAddresses, AccountData, Network, Transaction } from '../../types/wallet.ts'
import { partitionVerboseTransactions } from './transparent-history-cache.ts'
import {
  getRequiredConfirmations,
  mergeTransactionUpdate,
  mergeZcashReceiveObservation,
  synchronizeInternalTransferConfirmations,
  type ConfirmationTrust,
  type ZcashConfirmation
} from '../../lib/transaction-status.ts'
import {
  isDuplicateWasmRow,
  isTransparentReceive,
  localTxHashSet,
  normalizeTxHash
} from '../../lib/tx-history-dedup.ts'

const MAX_RECENT_TXS = 100
const FETCH_CONCURRENCY = 5
const HISTORY_CACHE_TTL_MS = 30_000
const ZATOSHIS_PER_ZEC = 10n ** BigInt(ZEC_DECIMALS)

function externalReceivesAwaitingConfirmation(transactions: Transaction[]): Transaction[] {
  const localHashes = localTxHashSet(transactions.filter(tx => tx.type !== 'receive'))
  const required = getRequiredConfirmations('receive')
  return transactions.filter(tx => {
    const hash = normalizeTxHash(tx.txHash)
    return (
      tx.type === 'receive' &&
      (tx.id.startsWith('wasm_') ||
        (tx.id.startsWith('rpc_treceive_') && isTransparentReceive(tx))) &&
      (tx.status === 'confirming' || tx.status === 'pending') &&
      (tx.requiredConfirmations == null || tx.requiredConfirmations === required) &&
      /^[0-9a-f]{64}$/.test(hash) &&
      !localHashes.has(hash)
    )
  })
}

export async function readExternalReceiveConfirmations(
  transactions: Transaction[],
  baseUrl: string,
  signal?: AbortSignal
): Promise<ReadonlyMap<string, number>> {
  const hashes = Array.from(
    new Set(
      externalReceivesAwaitingConfirmation(transactions).map(tx => normalizeTxHash(tx.txHash))
    )
  ).slice(0, MAX_RECENT_TXS)
  const observed = new Map<string, number>()
  await mapWithConcurrency(hashes, FETCH_CONCURRENCY, async hash => {
    if (signal?.aborted) return
    const lookup = await lookupTransaction(baseUrl, hash, signal)
    if (lookup.status === 'confirmed') observed.set(hash, lookup.confirmations)
  })
  return observed
}

export function applyExternalReceiveConfirmations(
  transactions: Transaction[],
  observed: ReadonlyMap<string, number>
): Transaction[] {
  const eligible = new Set(externalReceivesAwaitingConfirmation(transactions))
  const requiredConfirmations = getRequiredConfirmations('receive')
  let changed = false
  const updated = transactions.map(transaction => {
    if (!eligible.has(transaction)) return transaction
    const confirmations = observed.get(normalizeTxHash(transaction.txHash))
    const status =
      confirmations != null && confirmations >= requiredConfirmations ? 'success' : 'confirming'
    if (
      confirmations == null ||
      confirmations < (transaction.confirmations ?? 0) ||
      (confirmations === transaction.confirmations && status === transaction.status)
    ) {
      return transaction
    }
    changed = true
    return mergeZcashReceiveObservation(transaction, {
      ...transaction,
      status,
      confirmations,
      requiredConfirmations
    })
  })
  return changed ? updated : transactions
}

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
  transparentReceives: Transaction[],
  accountAddresses?: AccountAddresses
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
    const shieldedOutput = transaction.type === 'shield' && walletHistory.type === 'shield'
    const transparentOutput = transaction.type === 'unshield' && isTransparentReceive(walletHistory)
    return mergeTransactionUpdate(
      transaction,
      {
        status: walletHistory.status,
        confirmations: walletHistory.confirmations,
        requiredConfirmations: walletHistory.requiredConfirmations,
        amount: shieldedOutput
          ? safeBig(walletHistory.amount)
              .plus(walletHistory.fee ?? 0)
              .toFixed()
          : transaction.amount,
        ...(walletHistory.status === 'success' && (shieldedOutput || transparentOutput)
          ? { settledSelfTransferAmount: walletHistory.amount }
          : {})
      },
      confirmation
    )
  })
  const currentById = new Map(refreshedCurrentTransactions.map(tx => [tx.id, tx]))
  const localShieldRecipients = new Map<string, string>()
  for (const transaction of refreshedCurrentTransactions) {
    if (
      transaction.type === 'send' &&
      transaction.fromType === 'transparent' &&
      !transaction.id.startsWith('wasm_') &&
      transaction.txHash &&
      transaction.to &&
      (transaction.to === accountAddresses?.shielded ||
        transaction.to === accountAddresses?.fullUnified)
    ) {
      localShieldRecipients.set(
        `${transaction.network}:${normalizeTxHash(transaction.txHash)}`,
        transaction.to
      )
    }
  }
  const observedShieldReceiptKeys = new Set(
    wasmTransactions
      .filter(transaction => transaction.type === 'receive' && transaction.fromType === 'shielded')
      .map(transaction => `${transaction.network}:${normalizeTxHash(transaction.txHash)}`)
  )
  const reconciledWasmTransactions = wasmTransactions.map(wasmTransaction => {
    const key = `${wasmTransaction.network}:${normalizeTxHash(wasmTransaction.txHash)}`
    const recipient = localShieldRecipients.get(key)
    const transaction: Transaction =
      wasmTransaction.type === 'shield' &&
      wasmTransaction.status === 'success' &&
      safeBig(wasmTransaction.amount).gt(0) &&
      recipient &&
      !observedShieldReceiptKeys.has(key)
        ? { ...wasmTransaction, type: 'receive', fromType: 'shielded', to: recipient, fee: '0' }
        : wasmTransaction
    const current = currentById.get(transaction.id)
    if (!current) {
      return {
        ...transaction,
        timestamp: transaction.timestamp > 0 ? transaction.timestamp : Date.now()
      }
    }
    const observation = {
      ...transaction,
      timestamp: transaction.timestamp > 0 ? transaction.timestamp : current.timestamp,
      to: transaction.to || (current.type === transaction.type ? current.to : '')
    }
    if (current.type === 'receive' && transaction.type === 'receive') {
      return mergeZcashReceiveObservation(current, observation)
    }
    const confirmation: ZcashConfirmation | undefined =
      transaction.status === 'success' && transaction.confirmations != null
        ? { txHash: transaction.txHash, confirmations: transaction.confirmations }
        : undefined
    return mergeTransactionUpdate(current, observation, confirmation)
  })
  const localHashes = localTxHashSet(refreshedCurrentTransactions)
  const newWasmTransactions = reconciledWasmTransactions.filter(
    tx => !isDuplicateWasmRow(tx, localHashes)
  )
  const newWasmIds = new Set(newWasmTransactions.map(tx => tx.id))
  const preservedTransactions = refreshedCurrentTransactions.filter(tx => {
    if (isDuplicateWasmRow(tx, localHashes)) return false
    if (!tx.id.startsWith('wasm_')) return true
    return !newWasmIds.has(tx.id)
  })
  const mergedWasmTransactions = [...preservedTransactions, ...newWasmTransactions].sort(
    (a, b) => b.timestamp - a.timestamp
  )

  const transactions = mergeTransactionsWithTransparentReceives(
    mergedWasmTransactions,
    transparentReceives
  )

  return {
    transactions: synchronizeInternalTransferConfirmations(transactions),
    newWasmTransactionCount: newWasmTransactions.length
  }
}

export function mergeTransactionsWithTransparentReceives(
  existingTransactions: Transaction[],
  transparentReceives: Transaction[]
): Transaction[] {
  const receiptsById = new Map<string, Transaction>()
  const preservedTransactions: Transaction[] = []
  for (const transaction of [...existingTransactions, ...transparentReceives]) {
    if (!normalizeTxHash(transaction.txHash) || !isTransparentReceive(transaction)) {
      preservedTransactions.push(transaction)
      continue
    }
    const previous = receiptsById.get(transaction.id)
    receiptsById.set(
      transaction.id,
      previous ? mergeZcashReceiveObservation(previous, transaction) : transaction
    )
  }
  const transactionScopedReceipts = new Map<string, Transaction>()
  for (const transaction of receiptsById.values()) {
    const hash = normalizeTxHash(transaction.txHash)
    const id = transaction.id.toLowerCase()
    if (id !== `wasm_${hash}` && id !== `rpc_treceive_${hash}`) {
      preservedTransactions.push(transaction)
      continue
    }
    const key = JSON.stringify([transaction.network, hash, transaction.to, transaction.amount])
    const existing = transactionScopedReceipts.get(key)
    if (!existing) {
      transactionScopedReceipts.set(key, transaction)
      continue
    }
    const [previous, observed] =
      existing.id.startsWith('rpc_treceive_') && transaction.id.startsWith('wasm_')
        ? [transaction, existing]
        : [existing, transaction]
    transactionScopedReceipts.set(
      key,
      mergeZcashReceiveObservation(
        previous,
        previous.status === 'failed' ? { ...observed, id: previous.id } : observed
      )
    )
  }
  return [...preservedTransactions, ...transactionScopedReceipts.values()].sort(
    (left, right) => right.timestamp - left.timestamp
  )
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
