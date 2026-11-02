export type HomeDefaultTab = 'assets' | 'lending' | 'activity'

export function resolveHomeDefaultTab(search: string, lendingAvailable = false): HomeDefaultTab {
  const tab = new URLSearchParams(search).get('tab')
  if (tab === 'activity') return 'activity'
  return tab === 'lending' && lendingAvailable ? 'lending' : 'assets'
}

export function clearHomeTransactionFocus(search: string): string | null {
  const params = new URLSearchParams(search)
  if (!params.has('transactionId')) return null
  params.delete('transactionId')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}

export function homeTabPath(search: string, tab: 'assets' | 'lending' | 'activity'): string {
  const params = new URLSearchParams(search)
  params.delete('transactionId')
  if (tab === 'activity' || tab === 'lending') params.set('tab', tab)
  else params.delete('tab')
  const remaining = params.toString()
  return remaining ? `/?${remaining}` : '/'
}
