export function canUseRouteBeforeBetaActivation(pathname: string): boolean {
  return (
    pathname.startsWith('/onboarding') ||
    pathname === '/unlock' ||
    pathname === '/terms-of-use' ||
    pathname === '/hardware/connect' ||
    pathname === '/hardware/keystone-connect' ||
    pathname === '/hardware/ledger-connect'
  )
}

export function getPendingBetaInviteReturnRoute(
  pathname: string,
  search: string,
  pendingActivation: boolean,
  specialWindow: boolean
): string | null {
  if (!pendingActivation || specialWindow || canUseRouteBeforeBetaActivation(pathname)) return null
  return `${pathname}${search}`
}
