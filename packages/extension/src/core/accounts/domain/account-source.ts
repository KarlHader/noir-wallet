/** External account ownership is independent from the parent wallet's HD keys. */
export type AccountSource = Readonly<{
  kind: 'frost-vault'
  version: 1
  groupId: string
  network: 'mainnet' | 'testnet'
}>

export function parseAccountSource(value: unknown): AccountSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid account source')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 4 ||
    !['kind', 'version', 'groupId', 'network'].every(key =>
      Object.prototype.hasOwnProperty.call(record, key)
    ) ||
    record.kind !== 'frost-vault' ||
    record.version !== 1 ||
    typeof record.groupId !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/.test(record.groupId) ||
    (record.network !== 'mainnet' && record.network !== 'testnet')
  )
    throw new Error('Invalid account source')
  return Object.freeze({
    kind: 'frost-vault',
    version: 1,
    groupId: record.groupId,
    network: record.network
  })
}

export function accountSourceEquals(
  left: AccountSource | undefined,
  right: AccountSource | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.kind === right.kind &&
    left.version === right.version &&
    left.groupId === right.groupId &&
    left.network === right.network
  )
}

export function isFrostAccount<T extends { readonly source?: AccountSource }>(
  account: T
): account is T & { readonly source: AccountSource } {
  return account.source?.kind === 'frost-vault'
}

export function isDerivedAccount<T extends { readonly source?: AccountSource }>(
  account: T
): account is T & { readonly source?: never } {
  return account.source === undefined
}

/** HD order stays unchanged; external accounts use creation order after derived accounts. */
export function compareAccounts(
  left: {
    readonly source?: AccountSource
    readonly accountIndex?: number
    readonly createdAt: number
    readonly id: string
  },
  right: {
    readonly source?: AccountSource
    readonly accountIndex?: number
    readonly createdAt: number
    readonly id: string
  }
): number {
  if (
    left.source === undefined &&
    right.source === undefined &&
    left.accountIndex !== undefined &&
    right.accountIndex !== undefined
  ) {
    return left.accountIndex - right.accountIndex || left.id.localeCompare(right.id)
  }
  if (left.source === undefined) return -1
  if (right.source === undefined) return 1
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}
