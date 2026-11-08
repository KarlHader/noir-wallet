import type { AssetDomain } from './asset-domains'

export type HomeDefaultTab = 'assets' | 'activity'

export function legacyShieldHomePath(search: string): string | null {
  const params = new URLSearchParams(search)
  if (params.get('tab') !== 'shield') return null
  params.delete('tab')
  params.delete('domain')
  params.delete('transactionId')
  const remaining = params.toString()
  return remaining ? `/shield-funds?${remaining}` : '/shield-funds'
}

export function resolveHomeDefaultTab(search: string): HomeDefaultTab {
  const tab = new URLSearchParams(search).get('tab')
  if (tab === 'activity') return 'activity'
  return 'assets'
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
  if (tab === 'activity') params.set('tab', tab)
  else {
    params.delete('tab')
    params.delete('assetId')
    params.delete('mode')
  }
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}

export function clearHomeActivityAssetFilter(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('assetId')
  params.delete('domain')
  params.delete('mode')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}

export function resolveHomeAssetDomain(search: string): AssetDomain {
  const params = new URLSearchParams(search)
  const domain = params.get('domain')
  return domain === 'public' || domain === 'private' || domain === 'shield' ? domain : 'all'
}

export function homeAssetDomainPath(search: string, domain: AssetDomain): string {
  const params = new URLSearchParams(search)
  params.delete('transactionId')
  params.delete('assetId')
  params.delete('mode')
  if (domain === 'all') params.delete('domain')
  else params.set('domain', domain)
  if (params.get('tab') !== 'activity') params.delete('tab')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}
