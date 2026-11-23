import type { AssetDomain } from './asset-domains'
import { EXTENSION_ACTIVITY_ROUTE } from '@/config/extension'

export type HomeDefaultTab = 'assets' | 'dapp' | 'providers' | 'activity'
export type HomeAssetDomain = Exclude<AssetDomain, 'all'>

function isHomeSecondaryTab(
  tab: string | null,
  domain: HomeAssetDomain
): tab is 'dapp' | 'providers' | 'activity' {
  return tab === 'activity' || tab === (domain === 'shield' ? 'providers' : 'dapp')
}

export function legacyShieldHomePath(search: string): string | null {
  const params = new URLSearchParams(search)
  if (params.get('tab') !== 'shield') return null
  return resolveLegacyShieldFundsPath(search)
}

export function resolveLegacyShieldFundsPath(search: string): string {
  const params = new URLSearchParams(search)
  const action = params.get('action')
  const assetId = params.get('assetId')
  const asset = assetId ? `&assetId=${encodeURIComponent(assetId)}` : ''
  if (action === 'send') return `/send?sourceMode=shield${asset}`
  if (action === 'receive') return `/receive?mode=shield${asset}`
  if (action === 'swap') return '/swap?balanceDomain=shield'
  return '/?domain=shield&tab=providers'
}

export function resolveHomeDefaultTab(search: string): HomeDefaultTab {
  const tab = new URLSearchParams(search).get('tab')
  return isHomeSecondaryTab(tab, resolveHomeAssetDomain(search)) ? tab : 'assets'
}

export function homeActivityPath(domain: HomeAssetDomain, transactionId?: string): string {
  const params = new URLSearchParams({ tab: 'activity' })
  if (domain !== 'public') params.set('domain', domain)
  if (transactionId) params.set('transactionId', transactionId)
  return `/?${params}`
}

export function resolveWalletEntryRoute(hash: string): string {
  const entry = hash.slice(1)
  if (entry === '/manage-tokens') return entry
  if (!entry.startsWith('/?')) return '/'
  const params = new URLSearchParams(entry.slice(2))
  if (params.get('tab') !== 'activity') return '/'
  const domain = params.get('domain')
  const transactionId = params.get('transactionId')
  if (!transactionId) return EXTENSION_ACTIVITY_ROUTE
  return homeActivityPath(
    domain === 'shield' || domain === 'private' ? domain : 'public',
    transactionId
  )
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
  if (isHomeSecondaryTab(tab, resolveHomeAssetDomain(search))) {
    params.set('tab', tab)
  } else {
    params.delete('tab')
  }
  if (tab !== 'activity') {
    params.delete('assetId')
    params.delete('mode')
  }
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}

export function clearHomeActivityAssetFilter(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('assetId')
  params.delete('mode')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}

export function resolveHomeAssetDomain(search: string): HomeAssetDomain {
  const params = new URLSearchParams(search)
  const domain = params.get('domain')
  return domain === 'private' || domain === 'shield' ? domain : 'public'
}

export function homeAssetDomainPath(search: string, domain: HomeAssetDomain): string {
  const params = new URLSearchParams(search)
  params.delete('transactionId')
  params.delete('assetId')
  params.delete('mode')
  if (domain === 'public') params.delete('domain')
  else params.set('domain', domain)
  if (resolveHomeDefaultTab(params.toString()) === 'assets') params.delete('tab')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}
