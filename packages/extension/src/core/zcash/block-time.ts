const APPROXIMATE_SEARCH_WINDOW = 1_000

export interface ExactBlockHeightLookup {
  targetTimestamp: number
  approximateHeight: number
  latestHeight: number
  getBlockTime: (height: number) => Promise<number>
}

/** Finds the first block whose timestamp is at or after the requested time. */
export async function findExactBlockHeightByTime({
  targetTimestamp,
  approximateHeight,
  latestHeight,
  getBlockTime
}: ExactBlockHeightLookup): Promise<number> {
  if (
    !Number.isSafeInteger(targetTimestamp) ||
    !Number.isSafeInteger(approximateHeight) ||
    !Number.isSafeInteger(latestHeight) ||
    approximateHeight <= 0 ||
    latestHeight <= 0
  ) {
    return 0
  }

  const approximate = Math.min(approximateHeight, latestHeight)
  const approximateTime = await getBlockTime(approximate)
  let lowerHeight: number
  let upperHeight: number

  if (approximateTime >= targetTimestamp) {
    upperHeight = approximate
    lowerHeight = Math.max(1, approximate - APPROXIMATE_SEARCH_WINDOW)

    let step = APPROXIMATE_SEARCH_WINDOW
    let lowerTime = await getBlockTime(lowerHeight)
    while (lowerHeight > 1 && lowerTime >= targetTimestamp) {
      upperHeight = lowerHeight
      step *= 2
      lowerHeight = Math.max(1, lowerHeight - step)
      lowerTime = await getBlockTime(lowerHeight)
    }

    if (lowerHeight === 1 && lowerTime >= targetTimestamp) return 1
  } else {
    lowerHeight = approximate
    upperHeight = Math.min(latestHeight, approximate + APPROXIMATE_SEARCH_WINDOW)

    let step = APPROXIMATE_SEARCH_WINDOW
    let upperTime = await getBlockTime(upperHeight)
    while (upperHeight < latestHeight && upperTime < targetTimestamp) {
      lowerHeight = upperHeight
      step *= 2
      upperHeight = Math.min(latestHeight, upperHeight + step)
      upperTime = await getBlockTime(upperHeight)
    }

    if (upperHeight === latestHeight && upperTime < targetTimestamp) return latestHeight
  }

  while (upperHeight - lowerHeight > 1) {
    const middleHeight = lowerHeight + Math.floor((upperHeight - lowerHeight) / 2)
    const middleTime = await getBlockTime(middleHeight)
    if (middleTime < targetTimestamp) lowerHeight = middleHeight
    else upperHeight = middleHeight
  }

  return upperHeight
}
