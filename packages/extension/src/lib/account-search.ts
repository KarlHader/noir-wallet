interface SearchableAccount {
  name: string
  walletName: string
  addresses: readonly { readonly address: string }[]
}

export function matchesAccountSearch(account: SearchableAccount, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true

  return (
    account.name.toLowerCase().includes(normalizedQuery) ||
    account.walletName.toLowerCase().includes(normalizedQuery) ||
    account.addresses.some(({ address }) => address.toLowerCase().includes(normalizedQuery))
  )
}
