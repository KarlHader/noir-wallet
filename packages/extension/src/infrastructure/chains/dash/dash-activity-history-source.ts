import type { ActivityItem, ActivityScope } from '@/core/activity'
import { parseAssetId, parseChainId } from '@/core/chains/registry'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { DashRpcError, type DashTransaction } from './dash-insight-codecs'
import { DASH_REQUIRED_CONFIRMATIONS, parseDashRecipient } from './dash-transaction-model'

const MAX_PAGES = 5

export interface DashActivityHistorySource {
  readonly readAddressActivity: (input: {
    readonly scope: ActivityScope
    readonly addresses: readonly string[]
    readonly signal?: AbortSignal
  }) => Promise<readonly ActivityItem[]>
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
      const now = options.now?.() ?? Date.now()
      const items: ActivityItem[] = []
      for (const address of input.addresses) {
        parseDashRecipient(address, chainId)
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
            const received = transaction.outputs.some(output => output.addresses.includes(address))
            const spent = transaction.inputs.some(txInput => txInput.address === address)
            const direction =
              spent && !received ? 'outgoing' : received && !spent ? 'incoming' : 'self'
            const amount = transaction.outputs
              .filter(output =>
                direction === 'outgoing'
                  ? !output.addresses.includes(address)
                  : output.addresses.includes(address)
              )
              .reduce((sum, output) => sum + BigInt(output.valueDuffs), 0n)
            const status =
              transaction.confirmations >= DASH_REQUIRED_CONFIRMATIONS
                ? 'final'
                : transaction.confirmations > 0
                  ? 'confirming'
                  : 'broadcast'
            items.push(
              Object.freeze({
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
                  sender: Object.freeze({ chainId, address }),
                  recipient: Object.freeze({
                    chainId,
                    address:
                      transaction.outputs.find(output => !output.addresses.includes(address))
                        ?.addresses[0] ?? address
                  })
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
            )
          }
          page += 1
        }
      }
      return Object.freeze(items)
    }
  }
}
