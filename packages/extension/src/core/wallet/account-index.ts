const MAX_ZCASH_ACCOUNT_INDEX = 0x7fffffff

function assertAccountIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ZCASH_ACCOUNT_INDEX) {
    throw new Error('Invalid Zcash account derivation index')
  }
}

export function selectNextZcashAccountIndex(
  metadataIndexes: readonly number[],
  wasmIndexes: readonly (number | null)[]
): number {
  const indexes = [
    ...metadataIndexes,
    ...wasmIndexes.filter((value): value is number => value !== null)
  ]
  for (const index of indexes) assertAccountIndex(index)

  const nextIndex = indexes.length === 0 ? 0 : Math.max(...indexes) + 1
  if (nextIndex > MAX_ZCASH_ACCOUNT_INDEX) {
    throw new Error('Zcash account derivation index is exhausted')
  }
  return nextIndex
}
