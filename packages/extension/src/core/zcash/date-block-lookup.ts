import { getNetworkConfig } from '@/lib/runtime-network'
import { fetchBlockTime, fetchLatestBlockHeight } from '@/infrastructure/chains/rpc-registry-client'
import type { Network } from '../../types'

export const DATE_BLOCK_LOOKUP_TIMEOUT_MS = 60_000

const SAPLING_ACTIVATION_HEIGHT: Record<Network, number> = {
  mainnet: 419_200,
  testnet: 280_000
}

interface DateBlockLookupOptions {
  signal?: AbortSignal
  fetchFunction?: typeof fetch
  timeoutMs?: number
}

export async function lookupBlockHeightByTime(
  targetTimestamp: number,
  network: Network,
  {
    signal,
    fetchFunction = fetch,
    timeoutMs = DATE_BLOCK_LOOKUP_TIMEOUT_MS
  }: DateBlockLookupOptions = {}
): Promise<number> {
  if (
    !Number.isSafeInteger(targetTimestamp) ||
    targetTimestamp < 0 ||
    targetTimestamp > 0xffffffff
  ) {
    throw new Error('Invalid block timestamp')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid lookup timeout')

  const controller = new AbortController()
  const deadline = performance.now() + timeoutMs
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()

  const remainingMs = () => {
    if (controller.signal.aborted) throw new DOMException('Block lookup aborted', 'AbortError')
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new DOMException('Block lookup timed out', 'AbortError')
    return remaining
  }

  try {
    const rpcUrl = getNetworkConfig(network).rpcUrl
    const activationHeight = SAPLING_ACTIVATION_HEIGHT[network]
    const latestHeight = await fetchLatestBlockHeight(
      rpcUrl,
      fetchFunction,
      remainingMs(),
      controller.signal
    )
    if (latestHeight < activationHeight) {
      remainingMs()
      return 0
    }

    const readTime = (height: number) =>
      fetchBlockTime(rpcUrl, height, fetchFunction, remainingMs(), controller.signal)
    if (targetTimestamp <= (await readTime(activationHeight))) {
      remainingMs()
      return 0
    }
    if (targetTimestamp >= (await readTime(latestHeight))) {
      remainingMs()
      return latestHeight
    }

    let lowerHeight = activationHeight
    let upperHeight = latestHeight
    while (upperHeight - lowerHeight > 1) {
      const middleHeight = lowerHeight + Math.floor((upperHeight - lowerHeight) / 2)
      if ((await readTime(middleHeight)) < targetTimestamp) {
        lowerHeight = middleHeight
      } else {
        upperHeight = middleHeight
      }
    }
    remainingMs()
    return upperHeight
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
