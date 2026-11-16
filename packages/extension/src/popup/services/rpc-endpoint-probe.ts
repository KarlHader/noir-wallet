import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import type { ChainEndpointSettings } from '@/core/chains/chain-endpoint-settings'
import type { RpcEndpointGroup } from '@/config/rpc-endpoints'
import { attestBitcoinEsploraEndpoint } from '@/infrastructure/chains/bitcoin'
import { attestEvmRpcEndpoint } from '@/infrastructure/chains/evm'
import { attestNearRpcEndpoint } from '@/infrastructure/chains/near/near-network-attestation'
import { attestSolanaRpcEndpoint } from '@/infrastructure/chains/solana/solana-network-attestation'
import { attestZcashLightwalletdEndpoint } from '@/infrastructure/chains/zcash/zcash-network-attestation'
import type { RpcChainOption } from './chain-settings-options'
import { getSavedRpcEndpoints } from './rpc-endpoint-model'

export interface RpcProbeTarget {
  readonly option: RpcChainOption
  readonly url: string
}

const RPC_PROBE_TIMEOUT_MS = 10_000
const SUCCESSFUL_PROBE_TTL_MS = 30_000
const recentProbes = new Map<string, { latencyMs: number; expiresAt: number }>()

export function buildRpcProbeTargets(input: {
  readonly settings: ChainEndpointSettings
  readonly zcashOption: RpcChainOption
  readonly editingRegistryGroup: RpcEndpointGroup | null
  readonly editing: RpcChainOption | null
}): RpcProbeTarget[] {
  const { settings, zcashOption, editingRegistryGroup, editing } = input
  const targets: RpcProbeTarget[] = []
  if (editingRegistryGroup) {
    targets.push(
      ...editingRegistryGroup.options.map(endpoint => ({ option: zcashOption, url: endpoint.url }))
    )
    targets.push(
      ...getSavedRpcEndpoints(settings, zcashOption).map(endpoint => ({
        option: zcashOption,
        url: endpoint.url
      }))
    )
  }
  if (editing) {
    targets.push(
      ...(editing.presets ?? []).map(endpoint => ({ option: editing, url: endpoint.url }))
    )
    targets.push(
      ...getSavedRpcEndpoints(settings, editing).map(endpoint => ({
        option: editing,
        url: endpoint.url
      }))
    )
  }
  return targets
}

export function rpcProbeKey({ option, url }: RpcProbeTarget): string {
  return `${option.chainId}:${new URL(url).toString()}`
}

export async function probeChainRpcEndpoint(
  { option, url }: RpcProbeTarget,
  signal: AbortSignal
): Promise<number> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), RPC_PROBE_TIMEOUT_MS)
  const startedAt = performance.now()
  try {
    switch (option.protocol) {
      case 'evm-json-rpc':
        await attestEvmRpcEndpoint({
          chainId: option.chainId,
          rpcUrl: url,
          signal: controller.signal
        })
        break
      case 'bitcoin-esplora':
        await attestBitcoinEsploraEndpoint(option.chainId, url, controller.signal)
        break
      case 'solana-json-rpc':
        await attestSolanaRpcEndpoint({
          chainId: option.chainId,
          rpcUrl: url,
          signal: controller.signal
        })
        break
      case 'near-json-rpc':
        await attestNearRpcEndpoint({
          chainId: option.chainId,
          rpcUrl: url,
          signal: controller.signal
        })
        break
      case 'zcash-lightwalletd':
        await attestZcashLightwalletdEndpoint({
          network: DEFAULT_NETWORK,
          baseUrl: url,
          signal: controller.signal
        })
        break
      default:
        throw new Error('Unsupported RPC protocol')
    }
    return Math.round(performance.now() - startedAt)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}

export async function probeRpcTargets(
  targets: readonly RpcProbeTarget[],
  signal: AbortSignal,
  onResult: (key: string, latencyMs: number | null) => void
): Promise<void> {
  const unique = [...new Map(targets.map(target => [rpcProbeKey(target), target])).values()]
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (!signal.aborted && next < unique.length) {
        const target = unique[next++]
        const key = rpcProbeKey(target)
        const recent = recentProbes.get(key)
        if (recent && recent.expiresAt > Date.now()) {
          onResult(key, recent.latencyMs)
          continue
        }
        try {
          const latencyMs = await probeChainRpcEndpoint(target, signal)
          if (!signal.aborted) {
            recentProbes.set(key, { latencyMs, expiresAt: Date.now() + SUCCESSFUL_PROBE_TTL_MS })
            onResult(key, latencyMs)
          }
        } catch {
          if (!signal.aborted) onResult(key, null)
        }
      }
    })
  )
}
