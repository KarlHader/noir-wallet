const AUTO_CONNECT_DAPP_ORIGINS: ReadonlySet<string> = new Set([
  'https://app.zknoir.com',
  'https://noirdevelop.refburrow.top'
])

export function shouldAutoConnectDApp(origin: string): boolean {
  return AUTO_CONNECT_DAPP_ORIGINS.has(origin)
}

export function getDAppSessionScopeLimit(origin?: string): number {
  // Official apps include the bundled catalog and up to 32 custom EVM networks.
  return origin !== undefined && shouldAutoConnectDApp(origin) ? 64 : 16
}
