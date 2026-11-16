import { useEffect, useState } from 'react'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { formatConfirmationTime } from '@/popup/services/confirmation-time-format'

const fallbackSecondsByChain: Readonly<Record<string, number>> = Object.freeze({
  'eip155:1': 30,
  'eip155:56': 5,
  'eip155:42161': 5,
  'eip155:8453': 5,
  'eip155:10': 10,
  'eip155:137': 10,
  'eip155:43114': 5,
  'eip155:143': 5,
  'eip155:100': 15,
  'eip155:9745': 10,
  'eip155:196': 5,
  'eip155:80094': 10,
  'eip155:11155111': 30,
  'eip155:97': 5,
  'eip155:421614': 5,
  'eip155:84532': 5,
  'eip155:11155420': 10,
  'eip155:80002': 10,
  'eip155:43113': 5
})

export function useEvmConfirmationEstimate({
  enabled,
  fallbackEnabled = enabled,
  requestKey,
  chainId,
  feeEstimate
}: {
  readonly enabled: boolean
  readonly fallbackEnabled?: boolean
  readonly requestKey: string
  readonly chainId: string
  readonly feeEstimate: {
    readonly chainId: string
    readonly maxFeePerGasWei: string | null
    readonly maxPriorityFeePerGasWei: string | null
  } | null
}): string {
  const estimateChainId = feeEstimate?.chainId
  const maxFeePerGasWei = feeEstimate?.maxFeePerGasWei
  const maxPriorityFeePerGasWei = feeEstimate?.maxPriorityFeePerGasWei
  const key = JSON.stringify([
    requestKey,
    estimateChainId,
    maxFeePerGasWei,
    maxPriorityFeePerGasWei
  ])
  const [state, setState] = useState({ key: '', value: '—' })
  const fallbackSeconds = fallbackSecondsByChain[chainId]
  const fallback = fallbackSeconds
    ? formatConfirmationTime({ minimumSeconds: fallbackSeconds, maximumSeconds: fallbackSeconds })
    : '—'

  useEffect(() => {
    let active = true
    setState({ key, value: '—' })
    if (!enabled || !estimateChainId || !maxFeePerGasWei || !maxPriorityFeePerGasWei) return

    const refresh = async () => {
      try {
        const estimate = await evmWalletClient.getConfirmationEstimate({
          chainId: estimateChainId,
          maxFeePerGasWei,
          maxPriorityFeePerGasWei
        })
        if (active) setState({ key, value: formatConfirmationTime(estimate) })
      } catch {
        if (active) setState({ key, value: '—' })
      }
    }
    void refresh()
    return () => {
      active = false
    }
  }, [enabled, key, estimateChainId, maxFeePerGasWei, maxPriorityFeePerGasWei])

  return fallbackEnabled
    ? enabled && state.key === key && state.value !== '—'
      ? state.value
      : fallback
    : '—'
}
