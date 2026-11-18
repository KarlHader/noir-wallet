import { decodeFunctionResult, encodeFunctionData, erc20Abi, multicall3Abi } from 'viem'
import { findBuiltinEvmNetworkConfig } from '@/config/networks'
import {
  findChainEndpointOverride,
  getActiveChainEndpointSettings
} from '@/core/chains/chain-endpoint-settings'
import type { AssetRegistryEntry } from '@/core/chains/registry'
import type { Network } from '@/types'
import { getEvmRpcEndpointOptions } from '../managed-rpc-endpoints'
import { createEvmRpcClient, EvmRpcError, type EvmContractRpc } from './evm-rpc-client'

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const BATCH_SIZE = 50
const PREFERRED_BALANCE_TIMEOUT_MS = 2_500

export function resolvePreferredEvmPortfolioRpc(
  network: Network,
  chainId: string
): EvmContractRpc | undefined {
  if (
    !findBuiltinEvmNetworkConfig(network, chainId) ||
    findChainEndpointOverride(getActiveChainEndpointSettings(), chainId)?.rpc
  ) {
    return undefined
  }
  const endpoint = getEvmRpcEndpointOptions(network, chainId).find(option => {
    const url = new URL(option.url)
    return (
      option.id === 'deltarpc' &&
      url.protocol === 'https:' &&
      url.hostname.endsWith('.deltarpc.com')
    )
  })
  return endpoint ? createEvmRpcClient({ chainId, rpcUrl: endpoint.url }) : undefined
}

export async function readPreferredEvmPortfolioBalances(
  rpc: EvmContractRpc,
  assets: readonly AssetRegistryEntry[],
  addresses: readonly `0x${string}`[],
  signal?: AbortSignal
): Promise<ReadonlyMap<string, ReadonlyMap<string, string>>> {
  const balances = new Map<string, Map<string, string>>()
  const deadline = AbortSignal.timeout(PREFERRED_BALANCE_TIMEOUT_MS)
  const preferredSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const throwIfCancelled = () => {
    if (signal?.aborted) throw new EvmRpcError('cancelled', 'EVM balance read was cancelled')
  }
  try {
    await rpc.assertExpectedChain(preferredSignal)
  } catch {
    throwIfCancelled()
    return balances
  }

  const supported = assets.filter(
    ({ asset }) =>
      (asset.kind === 'native' && asset.namespace === 'slip44') ||
      (asset.kind === 'token' && asset.namespace === 'erc20')
  )
  await Promise.all(
    addresses.map(async address => {
      const accountBalances = new Map<string, string>()
      balances.set(address, accountBalances)
      for (let offset = 0; offset < supported.length; offset += BATCH_SIZE) {
        if (preferredSignal.aborted) break
        const batch = supported.slice(offset, offset + BATCH_SIZE)
        const calls = batch.map(({ asset }) => ({
          target: asset.kind === 'native' ? MULTICALL3 : (asset.reference as `0x${string}`),
          allowFailure: true,
          callData:
            asset.kind === 'native'
              ? encodeFunctionData({
                  abi: multicall3Abi,
                  functionName: 'getEthBalance',
                  args: [address]
                })
              : encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [address] })
        }))
        try {
          const data = encodeFunctionData({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            args: [calls]
          })
          const result = await rpc.callContract(MULTICALL3, data, preferredSignal)
          const items = decodeFunctionResult({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            data: result as `0x${string}`
          })
          if (items.length !== batch.length) break
          items.forEach(({ success, returnData }, index) => {
            if (success && /^0x[0-9a-fA-F]{64}$/.test(returnData)) {
              accountBalances.set(batch[index].asset.id, BigInt(returnData).toString())
            }
          })
        } catch {
          break
        }
      }
    })
  )
  throwIfCancelled()
  return balances
}
