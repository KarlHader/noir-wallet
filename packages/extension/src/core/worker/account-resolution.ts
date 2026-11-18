export type ExternalWasmIdentity = {
  walletId: string
  accountId: string
  groupId: string
  network: 'mainnet' | 'testnet'
}

export type ExternalWasmAccountPort = {
  findByName(name: string): Promise<number | null>
  getHdIndex(id: number): Promise<number | null | undefined>
  getAddresses(id: number): Promise<{ unified?: string; full_unified?: string; orchard?: string }>
  importAccount(name: string): Promise<number>
}

function externalAccountName(identity: ExternalWasmIdentity): string {
  if (
    !identity.walletId ||
    !identity.accountId ||
    !identity.groupId ||
    !['mainnet', 'testnet'].includes(identity.network)
  )
    throw new Error('Invalid external account identity')
  return `noir:frost:v1:${JSON.stringify([
    identity.network,
    identity.walletId,
    identity.accountId,
    identity.groupId
  ])}`
}

async function assertExternalIdentity(
  port: ExternalWasmAccountPort,
  id: number,
  expectedAddress: string
): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 0 || !expectedAddress) {
    throw new Error('External account identity mismatch')
  }
  const index = await port.getHdIndex(id)
  const addresses = await port.getAddresses(id)
  if (index != null || !Object.values(addresses).includes(expectedAddress)) {
    throw new Error('External account identity mismatch')
  }
}

export async function resolveExternalWasmAccount(
  port: ExternalWasmAccountPort,
  identity: ExternalWasmIdentity,
  expectedAddress: string
): Promise<number | null> {
  const id = await port.findByName(externalAccountName(identity))
  if (id === null) return null
  await assertExternalIdentity(port, id, expectedAddress)
  return id
}

export async function registerExternalWasmAccount(
  port: ExternalWasmAccountPort,
  identity: ExternalWasmIdentity,
  expectedAddress: string
): Promise<number> {
  const existing = await resolveExternalWasmAccount(port, identity, expectedAddress)
  if (existing !== null) return existing
  const id = await port.importAccount(externalAccountName(identity))
  await assertExternalIdentity(port, id, expectedAddress)
  return id
}

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
