function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstChainHash(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined
  for (const entry of value) {
    const candidate = record(entry)?.hash ?? entry
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

export function readRheaDestinationHash(value: unknown): string | undefined {
  const response = record(value)
  if (!response) return undefined
  const data = record(response.data)
  const details = record(response.swapDetails) ?? record(data?.swapDetails)
  const candidate = [
    response.toHash,
    response.to_hash,
    response.destinationTxHash,
    response.destination_hash,
    data?.toHash,
    data?.to_hash,
    data?.destinationTxHash,
    data?.destination_hash,
    firstChainHash(details?.destinationChainTxHashes)
  ].find(entry => entry !== undefined && entry !== null && entry !== '')
  if (candidate === undefined) return undefined
  if (
    typeof candidate !== 'string' ||
    !/^(?:0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,100})$/.test(candidate)
  ) {
    throw new Error('RHEA Swap destination transaction hash is invalid')
  }
  return /^0x[0-9a-fA-F]{64}$/.test(candidate) ? candidate.toLowerCase() : candidate
}
