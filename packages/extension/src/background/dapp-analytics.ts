import { ANALYTICS_EVENTS, PAGE_IDS, type AnalyticsEventName } from '../lib/analytics/constants'
import type { TrackOptions } from '../lib/analytics/types'
import { formatUnits } from 'viem'

export type DAppAnalyticsSink = (
  name: AnalyticsEventName,
  options: TrackOptions
) => void | Promise<unknown>
export type DAppAnalyticsChain = NonNullable<TrackOptions['chain']>

export function formatKnownAssetAmount(raw: string, decimals: number): string | undefined {
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(raw) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  ) {
    return undefined
  }
  return formatUnits(BigInt(raw), decimals)
}

export function isErc20ApprovalCall(valueRaw: string, calldata: string): boolean {
  return valueRaw === '0' && /^0x095ea7b30{24}[0-9a-f]{40}[0-9a-f]{64}$/.test(calldata)
}

export function emitDAppEvent(
  sink: DAppAnalyticsSink | undefined,
  chain: DAppAnalyticsChain,
  name: AnalyticsEventName,
  options: TrackOptions = {}
): void {
  try {
    void Promise.resolve(sink?.(name, { ...options, chain, pageId: PAGE_IDS.DAPP })).catch(() => {})
  } catch {
    // Reporting must not change the outcome of an approved wallet operation.
  }
}

function methodCategory(
  method: string
): 'connect' | 'sendTransaction' | 'signMessage' | 'session' | null {
  if (
    ['connect', 'requestAccounts', 'eth_requestAccounts', 'wallet_requestPermissions'].includes(
      method
    )
  )
    return 'connect'
  if (
    [
      'eth_sendTransaction',
      'sendBitcoin',
      'signPsbt',
      'signPsbts',
      'pushPsbt',
      'pushTx',
      'signTransaction',
      'signAllTransactions',
      'requestSignTransactions',
      'signAndSendTransaction',
      'signAndSendTransactions'
    ].includes(method)
  )
    return 'sendTransaction'
  if (['personal_sign', 'eth_signTypedData_v4', 'signMessage'].includes(method))
    return 'signMessage'
  if (method === 'wallet_createSession') return 'session'
  return null
}

export async function observeDAppRequest<T>(
  sink: DAppAnalyticsSink | undefined,
  chain: DAppAnalyticsChain,
  method: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    const result = await operation()
    if (methodCategory(method) === 'signMessage') {
      emitDAppEvent(sink, chain, ANALYTICS_EVENTS.DAPP_MESSAGE_SIGNED)
    }
    return result
  } catch (error) {
    const category = methodCategory(method)
    if (
      category &&
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 4001
    ) {
      emitDAppEvent(sink, chain, ANALYTICS_EVENTS.DAPP_REQUEST_REJECTED, {
        extra: { method: category }
      })
    }
    throw error
  }
}
