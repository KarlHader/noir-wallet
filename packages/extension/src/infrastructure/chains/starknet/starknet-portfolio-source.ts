import type { ChainAccount } from '@/core/accounts/domain'
import type { AssetRegistry } from '@/core/chains/registry'
import { getStarknetNetworkConfig } from '@/core/chains/starknet/network-config'
import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import type { PortfolioReadErrorCode, PortfolioSourceSnapshot } from '@/core/portfolio'
import type { Network } from '@/types'

import { readStarknetTokenBalance } from './starknet-balance-reader'
import {
  StarknetRpcError,
  type StarknetReadRpc,
  type StarknetRpcErrorCode
} from './starknet-rpc-types'

export interface ReadStarknetPortfolioSourceInput {
  readonly chainAccount: ChainAccount
  readonly assets: AssetRegistry
  readonly rpc: Pick<StarknetReadRpc, 'call'>
  readonly network: Network
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function mapErrorCode(code: StarknetRpcErrorCode): PortfolioReadErrorCode {
  switch (code) {
    case 'network-unavailable':
    case 'timeout':
    case 'cancelled':
      return 'network-unavailable'
    case 'invalid-response':
      return 'invalid-response'
    case 'rpc-error':
    case 'contract-not-found':
    case 'transaction-not-found':
    case 'entrypoint-not-found':
      return 'unknown'
  }
}

function readAccountAddress(chainAccount: ChainAccount): string {
  if (chainAccount.identity.kind !== 'account-identifier') {
    throw new Error('Starknet portfolio requires an account address')
  }
  if (chainAccount.derivation.scheme !== 'bip44' && chainAccount.derivation.scheme !== 'eip2645') {
    throw new Error('Starknet portfolio account uses an unsupported derivation')
  }
  return normalizeStarknetFelt(chainAccount.identity.value)
}

export async function readStarknetPortfolioSource(
  input: ReadStarknetPortfolioSourceInput
): Promise<PortfolioSourceSnapshot> {
  const address = readAccountAddress(input.chainAccount)
  const chainId = input.chainAccount.scope.chainId
  const config = getStarknetNetworkConfig(input.network)
  if (config.chainId !== chainId)
    throw new Error('Starknet portfolio chain does not match the network')
  const tokens = input.assets
    .list(chainId)
    .flatMap(entry =>
      entry.asset.kind === 'token' && entry.asset.namespace === 'snip2' ? [entry] : []
    )
  const updatedAt = (input.now ?? Date.now)()
  try {
    const balances = await Promise.all(
      tokens.map(async entry => {
        const amount = await readStarknetTokenBalance(
          input.rpc,
          entry.asset.reference,
          address,
          input.signal
        )
        const raw = amount.toString()
        return Object.freeze({
          assetId: entry.asset.id,
          totalRaw: raw,
          spendableRaw: raw,
          availableRaw: raw,
          pendingRaw: '0',
          updatedAt
        })
      })
    )
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'ready',
      balances: Object.freeze(balances)
    })
  } catch (error) {
    const code = error instanceof StarknetRpcError ? mapErrorCode(error.code) : 'unknown'
    return Object.freeze({
      chainAccount: input.chainAccount,
      status: 'error',
      balances: Object.freeze([]),
      errorCode: code
    })
  }
}
