import type { AssetDomain } from './asset-domains'

export type HomeDefaultTab = 'assets' | 'shield' | 'lending' | 'activity'

export function resolveHomeDefaultTab(search: string, lendingAvailable = false): HomeDefaultTab {
  const tab = new URLSearchParams(search).get('tab')
  if (tab === 'activity') return 'activity'
  if (tab === 'shield') return 'shield'
  return tab === 'lending' && lendingAvailable ? 'lending' : 'assets'
}

export function clearHomeTransactionFocus(search: string): string | null {
  const params = new URLSearchParams(search)
  if (!params.has('transactionId')) return null
  params.delete('transactionId')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}

export function homeTabPath(search: string, tab: HomeDefaultTab): string {
  const params = new URLSearchParams(search)
  params.delete('transactionId')
  if (tab === 'activity' || tab === 'lending' || tab === 'shield') params.set('tab', tab)
  else params.delete('tab')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}

export function resolveHomeAssetDomain(search: string): AssetDomain {
  const params = new URLSearchParams(search)
  if (params.get('tab') === 'shield') return 'shield'
  const domain = params.get('domain')
  return domain === 'public' || domain === 'private' || domain === 'shield' ? domain : 'all'
}

export function homeAssetDomainPath(search: string, domain: AssetDomain): string {
  const params = new URLSearchParams(search)
  params.delete('transactionId')
  if (domain === 'all') params.delete('domain')
  else params.set('domain', domain)
  if (domain === 'shield') params.set('tab', 'shield')
  else params.delete('tab')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}
