import type { Network } from '@/types'
import { getAddressTxids, getVerboseTransaction } from '@/lib/zcash-node-rpc'
import { getSafeTransactionBirthdayHeight } from './birthday-height'

export type ZcashAccountHistoryInspection =
  | { readonly status: 'used'; readonly birthdayHeight: number | null }
  | { readonly status: 'unknown' }

interface ZcashAccountHistoryDependencies {
  readonly getAddressTxids: typeof getAddressTxids
  readonly getVerboseTransaction: typeof getVerboseTransaction
}

const defaultDependencies: ZcashAccountHistoryDependencies = {
  getAddressTxids,
  getVerboseTransaction
}

export async function inspectZcashTransparentAccountHistory(
  input: {
    readonly nodeRpcUrl: string
    readonly transparentAddress: string
    readonly network: Network
  },
  dependencies: ZcashAccountHistoryDependencies = defaultDependencies
): Promise<ZcashAccountHistoryInspection> {
  if (!input.nodeRpcUrl || !input.transparentAddress) return { status: 'unknown' }

  try {
    const txids = await dependencies.getAddressTxids(input.nodeRpcUrl, input.transparentAddress)
    if (!Array.isArray(txids) || txids.length === 0) return { status: 'unknown' }
    const firstTxid = txids[0]
    if (typeof firstTxid !== 'string' || firstTxid.length === 0 || firstTxid.length > 128) {
      return { status: 'unknown' }
    }

    const firstTransaction = await dependencies.getVerboseTransaction(input.nodeRpcUrl, firstTxid)
    return {
      status: 'used',
      birthdayHeight: getSafeTransactionBirthdayHeight(firstTransaction.height, input.network)
    }
  } catch {
    return { status: 'unknown' }
  }
}
