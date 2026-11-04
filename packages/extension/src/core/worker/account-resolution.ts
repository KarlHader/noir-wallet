export async function findWasmAccountIdByHdIndex(
  accountBalances: unknown,
  accountIndex: number,
  getHdIndex: (accountId: number) => Promise<number | null | undefined>
): Promise<number | null> {
  if (!Array.isArray(accountBalances)) return null
  for (const entry of accountBalances) {
    if (!Array.isArray(entry)) continue
    const accountId = entry[0]
    if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 0) continue
    if ((await getHdIndex(accountId)) === accountIndex) return accountId
  }
  return null
}

export async function mapWasmAccountIdsByHdIndex(
  accountBalances: unknown,
  getHdIndex: (accountId: number) => Promise<number | null | undefined>
): Promise<Map<number, number>> {
  const idsByIndex = new Map<number, number>()
  if (!Array.isArray(accountBalances)) return idsByIndex
  for (const entry of accountBalances) {
    if (!Array.isArray(entry)) continue
    const accountId = entry[0]
    if (typeof accountId !== 'number' || !Number.isSafeInteger(accountId) || accountId < 0) continue
    let index: number | null | undefined
    try {
      index = await getHdIndex(accountId)
    } catch {
      continue
    }
    if (
      typeof index === 'number' &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      !idsByIndex.has(index)
    ) {
      idsByIndex.set(index, accountId)
    }
  }
  return idsByIndex
}
