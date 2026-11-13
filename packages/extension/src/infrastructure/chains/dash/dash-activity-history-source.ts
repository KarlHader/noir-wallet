import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import {
  DashRpcError,
  type DashTransaction,
  type DashTransactionOutput
} from './dash-insight-codecs'
import { DASH_REQUIRED_CONFIRMATIONS, parseDashRecipient } from './dash-transaction-model'

const MAX_PAGES = 5

export interface DashActivityHistorySource {
  readonly readAddressActivity: (input: {
    readonly scope: ActivityScope
    readonly ownedAddresses: readonly string[]
    readonly historyAddresses: readonly string[]
    readonly signal?: AbortSignal
  }) => Promise<readonly ActivityItem[]>
}

function parseAddressList(
  values: readonly string[],
  chainId: string,
  label: string
): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`Invalid Dash ${label}`)
  const parsed = values.map(value => parseDashRecipient(value, chainId))
  return Object.freeze([...new Set(parsed)])
}

function isWalletOutput(
  output: DashTransactionOutput,
  ownedAddresses: ReadonlySet<string>
): boolean {
  return output.addresses.some(address => ownedAddresses.has(address))
}

function uniqueAddress(addresses: readonly (string | undefined)[]): string | undefined {
  const present = new Set(addresses.filter((address): address is string => address !== undefined))
  return present.size === 1 ? [...present][0] : undefined
}

function mapTransaction(
  transaction: DashTransaction,
  input: {
    readonly scope: ActivityScope
    readonly ownedAddresses: ReadonlySet<string>
  },
  chainId: ReturnType<typeof parseChainId>['id'],
  assetId: ReturnType<typeof parseAssetId>['id'],
  now: number
): ActivityItem | null {
  const walletInputs = transaction.inputs.filter(
    txInput => txInput.address !== undefined && input.ownedAddresses.has(txInput.address)
  )
  const externalInputs = transaction.inputs.filter(
    txInput => txInput.address !== undefined && !input.ownedAddresses.has(txInput.address)
  )
  const walletOutputs = transaction.outputs.filter(output =>
    isWalletOutput(output, input.ownedAddresses)
  )
  const externalOutputs = transaction.outputs.filter(
    output => !isWalletOutput(output, input.ownedAddresses)
  )
  if (walletInputs.length === 0 && walletOutputs.length === 0) return null
  // A transaction that only moves value between owned addresses is change or consolidation.
  if (walletInputs.length > 0 && externalOutputs.length === 0) return null

  const direction = walletInputs.length === 0 ? 'incoming' : 'outgoing'
  const amount = (direction === 'incoming' ? walletOutputs : externalOutputs).reduce(
    (sum, output) => sum + BigInt(output.valueDuffs),
    0n
  )
  if (amount <= 0n) return null
  const sender =
    direction === 'incoming'
      ? uniqueAddress(externalInputs.map(txInput => txInput.address))
      : uniqueAddress(walletInputs.map(txInput => txInput.address))
  const recipient =
    direction === 'outgoing'
      ? uniqueAddress(externalOutputs.flatMap(output => output.addresses))
      : uniqueAddress(walletOutputs.flatMap(output => output.addresses))
  const status =
    transaction.confirmations >= DASH_REQUIRED_CONFIRMATIONS
      ? 'final'
      : transaction.confirmations > 0
        ? 'confirming'
        : 'broadcast'
  return Object.freeze({
    id: `dash:${transaction.transactionId}`,
    source: 'rpc',
    scope: input.scope,
    kind: 'transfer',
    status,
    completeness: 'complete',
    createdAt: transaction.time * 1000,
    updatedAt: now,
    snapshot: Object.freeze({
      schemaVersion: 1,
      direction,
      primaryAmount: Object.freeze({
        assetId,
        amountRaw: amount.toString()
      }),
      ...(transaction.feeDuffs === undefined
        ? {}
        : {
            feeLimit: Object.freeze({
              assetId,
              amountRaw: transaction.feeDuffs
            })
          }),
      ...(sender === undefined ? {} : { sender: Object.freeze({ chainId, address: sender }) }),
      ...(recipient === undefined
        ? {}
        : { recipient: Object.freeze({ chainId, address: recipient }) })
    }),
    segments: Object.freeze([
      Object.freeze({
        id: `dash-segment:${transaction.transactionId}`,
        role: 'origin',
        target: Object.freeze({ kind: 'onchain', chainId }),
        status,
        evidence: Object.freeze({
          transactionHash: transaction.transactionId,
          confirmations: transaction.confirmations,
          requiredConfirmations: DASH_REQUIRED_CONFIRMATIONS
        })
      })
    ])
  })
}

export function createDashActivityHistorySource(options: {
  readonly chainId: string
  readonly rpc: {
    readonly getAddressTransactions: (
      address: string,
      pageNum: number,
      signal?: AbortSignal
    ) => Promise<{ readonly pagesTotal: number; readonly transactions: readonly DashTransaction[] }>
  }
  readonly now?: () => number
}): DashActivityHistorySource {
  if (options.chainId !== DASH_CHAIN_IDS.mainnet && options.chainId !== DASH_CHAIN_IDS.testnet) {
    throw new Error('Invalid Dash activity chain')
  }
  const chainId = parseChainId(options.chainId).id
  const assetId = parseAssetId(`${chainId}/slip44:5`).id
  return {
    async readAddressActivity(input) {
      const ownedAddresses = parseAddressList(input.ownedAddresses, chainId, 'owned addresses')
      const historyAddresses = parseAddressList(
        input.historyAddresses,
        chainId,
        'history addresses'
      )
      const owned = new Set(ownedAddresses)
      if (historyAddresses.some(address => !owned.has(address))) {
        throw new Error('Dash history address is not owned by the active Account')
      }
      if (historyAddresses.length === 0) return Object.freeze([])

      const now = options.now?.() ?? Date.now()
      const transactions = new Map<string, DashTransaction>()
      for (const address of historyAddresses) {
        let page = 0
        let pagesTotal = 1
        while (page < pagesTotal && page < MAX_PAGES) {
          let result: { pagesTotal: number; transactions: readonly DashTransaction[] }
          try {
            result = await options.rpc.getAddressTransactions(address, page, input.signal)
          } catch (error) {
            if (error instanceof DashRpcError) throw error
            throw new Error('Dash activity indexer is unavailable')
          }
          pagesTotal = result.pagesTotal
          for (const transaction of result.transactions) {
            if (!transactions.has(transaction.transactionId)) {
              transactions.set(transaction.transactionId, transaction)
            }
          }
          page += 1
        }
      }
      return Object.freeze(
        [...transactions.values()]
          .flatMap(transaction => {
            const item = mapTransaction(
              transaction,
              { scope: input.scope, ownedAddresses: owned },
              chainId,
              assetId,
              now
            )
            return item === null ? [] : [item]
          })
          .sort(
            (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)
          )
      )
    }
  }
}
