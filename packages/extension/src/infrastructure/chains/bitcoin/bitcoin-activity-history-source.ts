import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseSupportedBitcoinAddress } from '@/core/chains/bitcoin'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import {
  BitcoinRpcError,
  type BitcoinActivityHistoryRpc,
  type BitcoinDiscoveryRpc
} from './bitcoin-esplora-client'
import type {
  BitcoinHistoryOutput,
  BitcoinHistoryTransaction
} from './bitcoin-esplora-history-model'

const DEFAULT_CONCURRENCY = 4
const MAXIMUM_CONCURRENCY = 8
const MAXIMUM_HISTORY_ADDRESSES = 64
const MAXIMUM_ACTIVITY_ITEMS = 200

export const BITCOIN_ACTIVITY_HISTORY_LIMITS = Object.freeze({
  addresses: MAXIMUM_HISTORY_ADDRESSES,
  items: MAXIMUM_ACTIVITY_ITEMS
})

export interface BitcoinActivityHistorySourceConfig {
  readonly chainId: string
  readonly assetId: string
  readonly requiredConfirmations: number
  readonly rpc: BitcoinActivityHistoryRpc & Pick<BitcoinDiscoveryRpc, 'getTipHeight'>
  readonly concurrency?: number
  readonly now?: () => number
}

export interface ReadBitcoinAddressActivityInput {
  readonly scope: ActivityScope
  readonly ownedAddresses: readonly string[]
  readonly historyAddresses: readonly string[]
  readonly signal?: AbortSignal
}

export interface BitcoinActivityHistorySource {
  readonly readAddressActivity: (
    input: ReadBitcoinAddressActivityInput
  ) => Promise<readonly ActivityItem[]>
}

function parseConcurrency(value: number | undefined): number {
  const parsed = value ?? DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAXIMUM_CONCURRENCY) {
    throw new Error('Invalid Bitcoin history concurrency')
  }
  return parsed
}

function parseRequiredConfirmations(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_016) {
    throw new Error('Invalid Bitcoin history finality policy')
  }
  return value
}

function parseAddresses(
  values: readonly string[],
  chainId: ReturnType<typeof parseChainId>['id'],
  label: string,
  maximum = 40_000
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  const parsed = Object.freeze(values.map(value => parseSupportedBitcoinAddress(value, chainId)))
  if (new Set(parsed).size !== parsed.length) throw new Error(`Duplicate ${label}`)
  return parsed
}

function uniqueAddress(outputs: readonly BitcoinHistoryOutput[]): string | undefined {
  const addresses = new Set(
    outputs.flatMap(output => (output.address === undefined ? [] : [output.address]))
  )
  return addresses.size === 1 ? [...addresses][0] : undefined
}

function sumOutputs(outputs: readonly BitcoinHistoryOutput[]): bigint {
  return outputs.reduce((sum, output) => sum + BigInt(output.valueRaw), 0n)
}

function transactionTimestamp(transaction: BitcoinHistoryTransaction, now: () => number): number {
  const timestamp =
    !transaction.status.confirmed || transaction.status.blockTime === undefined
      ? now()
      : transaction.status.blockTime * 1_000
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new BitcoinRpcError('invalid-response', 'Invalid Bitcoin history timestamp')
  }
  return timestamp
}

function mapTransaction(
  transaction: BitcoinHistoryTransaction,
  input: ReadBitcoinAddressActivityInput,
  ownedAddresses: ReadonlySet<string>,
  chainId: ReturnType<typeof parseChainId>['id'],
  assetId: ReturnType<typeof parseAssetId>['id'],
  tipHeight: number,
  requiredConfirmations: number,
  now: () => number
): ActivityItem {
  const walletInputs = transaction.inputs.flatMap(item => {
    const output = item.previousOutput
    return output?.address !== undefined && ownedAddresses.has(output.address) ? [output] : []
  })
  const externalInputs = transaction.inputs.flatMap(item => {
    const output = item.previousOutput
    return output?.address !== undefined && !ownedAddresses.has(output.address) ? [output] : []
  })
  const unknownInputs = transaction.inputs.filter(
    item => item.previousOutput === null || item.previousOutput.address === undefined
  )
  const walletOutputs = transaction.outputs.filter(
    output => output.address !== undefined && ownedAddresses.has(output.address)
  )
  const externalOutputs = transaction.outputs.filter(
    output => output.address === undefined || !ownedAddresses.has(output.address)
  )
  const unknownValuedExternalOutputs = externalOutputs.filter(
    output => output.address === undefined && BigInt(output.valueRaw) > 0n
  )
  const walletInputValue = sumOutputs(walletInputs)
  const walletOutputValue = sumOutputs(walletOutputs)
  if (walletInputValue === 0n && walletOutputValue === 0n) {
    throw new BitcoinRpcError(
      'invalid-response',
      'Bitcoin history transaction does not involve the requested wallet'
    )
  }

  const direction =
    walletInputValue === 0n
      ? ('incoming' as const)
      : sumOutputs(externalOutputs) === 0n
        ? ('self' as const)
        : ('outgoing' as const)
  const primaryAmount =
    direction === 'incoming'
      ? walletOutputValue
      : direction === 'outgoing' && externalInputs.length === 0 && unknownInputs.length === 0
        ? sumOutputs(externalOutputs)
        : undefined
  const senderAddress =
    direction === 'incoming' ? uniqueAddress(externalInputs) : uniqueAddress(walletInputs)
  const recipientAddress =
    direction === 'outgoing' ? uniqueAddress(externalOutputs) : uniqueAddress(walletOutputs)
  const complete =
    primaryAmount !== undefined &&
    senderAddress !== undefined &&
    recipientAddress !== undefined &&
    unknownInputs.length === 0 &&
    unknownValuedExternalOutputs.length === 0 &&
    (direction !== 'outgoing' || externalInputs.length === 0) &&
    transaction.status.blockTime !== undefined

  let confirmations = 0
  if (transaction.status.confirmed) {
    const blockHeight = transaction.status.blockHeight
    if (blockHeight === undefined || transaction.status.blockHash === undefined) {
      throw new BitcoinRpcError('invalid-response', 'Incomplete confirmed Bitcoin history status')
    }
    if (blockHeight > tipHeight) {
      throw new BitcoinRpcError(
        'invalid-response',
        'Bitcoin history block height exceeds the chain tip'
      )
    }
    confirmations = tipHeight - blockHeight + 1
  }
  const status =
    transaction.status.confirmed && confirmations >= requiredConfirmations
      ? ('final' as const)
      : ('confirming' as const)
  const timestamp = transactionTimestamp(transaction, now)
  const id = `rpc:bitcoin:${transaction.transactionId}`
  return Object.freeze({
    id,
    source: 'rpc' as const,
    scope: input.scope,
    kind: 'transfer' as const,
    status,
    snapshot: Object.freeze({
      schemaVersion: 1 as const,
      direction,
      ...(primaryAmount === undefined
        ? {}
        : {
            primaryAmount: Object.freeze({ assetId, amountRaw: primaryAmount.toString() })
          }),
      ...(senderAddress === undefined
        ? {}
        : { sender: Object.freeze({ chainId, address: senderAddress }) }),
      ...(recipientAddress === undefined
        ? {}
        : { recipient: Object.freeze({ chainId, address: recipientAddress }) })
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `${id}:origin`,
        role: 'origin' as const,
        target: Object.freeze({ kind: 'onchain' as const, chainId }),
        status,
        evidence: Object.freeze({
          transactionHash: transaction.transactionId,
          ...(transaction.status.confirmed
            ? {
                blockHash: transaction.status.blockHash,
                blockHeight: transaction.status.blockHeight,
                confirmations,
                requiredConfirmations
              }
            : { confirmations: 0, requiredConfirmations })
        })
      })
    ]),
    completeness: complete ? ('complete' as const) : ('partial' as const),
    createdAt: timestamp,
    updatedAt: timestamp
  })
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<readonly R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return Object.freeze(results)
}

export function createBitcoinActivityHistorySource(
  config: BitcoinActivityHistorySourceConfig
): BitcoinActivityHistorySource {
  const chain = parseChainId(config.chainId)
  if (chain.namespace !== 'bip122') throw new Error('Bitcoin history requires a Bitcoin chain ID')
  const asset = parseAssetId(config.assetId)
  if (asset.chainId !== chain.id || asset.namespace !== 'slip44' || asset.reference !== '0') {
    throw new Error('Bitcoin history asset does not match its chain')
  }
  const requiredConfirmations = parseRequiredConfirmations(config.requiredConfirmations)
  const concurrency = parseConcurrency(config.concurrency)
  const now = config.now ?? Date.now

  return Object.freeze({
    readAddressActivity: async (input: ReadBitcoinAddressActivityInput) => {
      const owned = parseAddresses(input.ownedAddresses, chain.id, 'Bitcoin owned addresses')
      const history = parseAddresses(
        input.historyAddresses,
        chain.id,
        'Bitcoin history addresses',
        MAXIMUM_HISTORY_ADDRESSES
      )
      const ownedSet = new Set(owned)
      if (history.some(address => !ownedSet.has(address))) {
        throw new Error('Bitcoin history address is not owned by the active Account')
      }
      if (history.length === 0) return Object.freeze([])

      const controller = new AbortController()
      const onAbort = () => controller.abort()
      input.signal?.addEventListener('abort', onAbort, { once: true })
      if (input.signal?.aborted) controller.abort()
      try {
        const tipHeight = await config.rpc.getTipHeight(controller.signal)
        const groups = await mapWithConcurrency(history, concurrency, address =>
          config.rpc.getAddressTransactions(address, controller.signal)
        )
        const transactions = new Map<string, BitcoinHistoryTransaction>()
        for (const transaction of groups.flat()) {
          const existing = transactions.get(transaction.transactionId)
          if (existing && JSON.stringify(existing) !== JSON.stringify(transaction)) {
            throw new BitcoinRpcError(
              'invalid-response',
              'Bitcoin history providers returned conflicting transaction data'
            )
          }
          transactions.set(transaction.transactionId, transaction)
        }
        return Object.freeze(
          [...transactions.values()]
            .map(transaction =>
              mapTransaction(
                transaction,
                input,
                ownedSet,
                chain.id,
                asset.id,
                tipHeight,
                requiredConfirmations,
                now
              )
            )
            .sort(
              (left, right) =>
                right.updatedAt - left.updatedAt ||
                right.createdAt - left.createdAt ||
                left.id.localeCompare(right.id)
            )
            .slice(0, MAXIMUM_ACTIVITY_ITEMS)
        )
      } catch (error) {
        controller.abort()
        throw error
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
      }
    }
  })
}
