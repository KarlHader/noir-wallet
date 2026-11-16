import { parseZeroIndexerNodeStatus, type ZeroIndexerNodeStatus } from '@/core/zcash/zero-indexer'
import { getResponseErrorMessage } from '@/lib/errors'

type ZeroIndexerNodeMessage =
  | { type: 'GET_ZERO_INDEXER_NODE_STATUS'; refresh?: boolean }
  | { type: 'SELECT_ZERO_INDEXER_NODE'; endpointId: string | null }
  | { type: 'ADD_CUSTOM_ZERO_INDEXER_NODE'; label: string; url: string }
  | { type: 'REMOVE_CUSTOM_ZERO_INDEXER_NODE'; endpointId: string }

export interface ZeroIndexerNodeResult {
  status: ZeroIndexerNodeStatus
  warning?: string
}

export async function sendZeroIndexerNodeMessage(
  message: ZeroIndexerNodeMessage
): Promise<ZeroIndexerNodeResult> {
  const response: unknown = await chrome.runtime.sendMessage(message)
  if (!response || typeof response !== 'object') throw new Error('Could not load broadcast nodes')
  const result = response as {
    success?: unknown
    status?: unknown
    warning?: unknown
  }
  if (result.success !== true) {
    throw new Error(getResponseErrorMessage(response) ?? 'Could not load broadcast nodes')
  }
  return {
    status: parseZeroIndexerNodeStatus(result.status),
    warning: typeof result.warning === 'string' ? result.warning : undefined
  }
}
