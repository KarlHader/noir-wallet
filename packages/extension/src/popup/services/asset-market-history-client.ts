import {
  isAssetMarketHistoryRange,
  parseAssetMarketHistoryReadModel,
  type AssetMarketHistoryRange,
  type AssetMarketHistoryReadModel
} from '@/core/prices'

type AssetMarketHistoryRuntimeMessenger = (
  message: Readonly<Record<string, unknown>>
) => Promise<unknown>

export type AssetMarketHistoryResult =
  | Readonly<{ status: 'unsupported' }>
  | Readonly<{
      status: 'available'
      history: AssetMarketHistoryReadModel | null
      availableRanges: readonly AssetMarketHistoryRange[]
    }>

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function createAssetMarketHistoryClient(sendMessage: AssetMarketHistoryRuntimeMessenger) {
  return Object.freeze({
    async getHistory(
      assetId: string,
      range: AssetMarketHistoryRange,
      action: 'read' | 'refresh'
    ): Promise<AssetMarketHistoryResult> {
      const response = await sendMessage({
        type: 'GET_ASSET_MARKET_HISTORY',
        assetId,
        range,
        action
      })
      if (isRecord(response) && Object.keys(response).length === 1) {
        if (response.status === 'unsupported') return { status: 'unsupported' }
        if (typeof response.error === 'string') throw new Error(response.error)
      }
      if (
        !isRecord(response) ||
        Object.keys(response).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(response, 'result') ||
        !Array.isArray(response.availableRanges) ||
        response.availableRanges.length === 0 ||
        response.availableRanges.length > 6 ||
        !response.availableRanges.every(isAssetMarketHistoryRange) ||
        new Set(response.availableRanges).size !== response.availableRanges.length
      ) {
        throw new Error('Invalid asset market history response')
      }
      const availableRanges = Object.freeze([
        ...response.availableRanges
      ]) as readonly AssetMarketHistoryRange[]
      if (response.result === null) return { status: 'available', history: null, availableRanges }
      const result = parseAssetMarketHistoryReadModel(response.result)
      if (result.assetId !== assetId || result.range !== range) {
        throw new Error('Asset market history response does not match the request')
      }
      return { status: 'available', history: result, availableRanges }
    }
  })
}

export const assetMarketHistoryClient = createAssetMarketHistoryClient(message =>
  chrome.runtime.sendMessage(message)
)
