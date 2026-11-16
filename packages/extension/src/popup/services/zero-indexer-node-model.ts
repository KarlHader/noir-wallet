import { normalizeZeroIndexerUrl, type ZeroIndexerNodeStatus } from '@/core/zcash/zero-indexer'

export function selectedZeroIndexerNodeLabel(status: ZeroIndexerNodeStatus | null): string {
  if (!status || status.mode === 'auto') return 'Auto'
  return (
    [...status.managedEndpoints, ...status.customEndpoints].find(
      endpoint => endpoint.id === status.selectedEndpointId
    )?.label ?? 'Auto'
  )
}

export function validateZeroIndexerNodeUrl(value: string): string | null {
  const input = value.trim()
  if (!input) return 'Enter a URL'
  try {
    normalizeZeroIndexerUrl(input)
  } catch {
    return 'Enter a valid HTTPS URL without credentials, query, or fragment'
  }
  return null
}

export function zeroIndexerNodeErrorField(error: string): 'name' | 'url' | 'general' {
  if (/name|label/i.test(error)) return 'name'
  if (/url|https|endpoint|node/i.test(error)) return 'url'
  return 'general'
}
