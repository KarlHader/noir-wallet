import { useEffect, useState } from 'react'
import type { SigningSummary } from '@/core/keyring/domain'
import { evmWalletClient } from '@/popup/services/evm-wallet-client'
import { formatConfirmationTime } from '@/popup/services/confirmation-time-format'

export function useEvmConfirmationEstimate({
  enabled,
  requestKey,
  summary
}: {
  readonly enabled: boolean
  readonly requestKey: string
  readonly summary: SigningSummary | null
}): string {
  const fields = summary?.schema === 'evm.transaction.v1' ? summary.fields : null
  const chainId = summary?.chainId
  const maxFeePerGasWei = fields?.maxFeePerGasWei
  const maxPriorityFeePerGasWei = fields?.maxPriorityFeePerGasWei
  const key = JSON.stringify([requestKey, chainId, maxFeePerGasWei, maxPriorityFeePerGasWei])
  const [state, setState] = useState({ key: '', value: '—' })

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({ key, value: '—' })
    if (!enabled || !chainId || !maxFeePerGasWei || !maxPriorityFeePerGasWei) return

    const refresh = async () => {
      try {
        const estimate = await evmWalletClient.getConfirmationEstimate({
          chainId,
          maxFeePerGasWei,
          maxPriorityFeePerGasWei
        })
        if (active) setState({ key, value: formatConfirmationTime(estimate) })
      } catch {
        if (active) setState({ key, value: '—' })
      }
      if (active) {
        timer = setTimeout(() => {
          setState({ key, value: '—' })
          void refresh()
        }, 30_000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [enabled, key, chainId, maxFeePerGasWei, maxPriorityFeePerGasWei])

  return enabled && state.key === key ? state.value : '—'
}
