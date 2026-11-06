const AUTO_CONNECT_DAPP_ORIGINS: ReadonlySet<string> = new Set([
  'https://app.zknoir.com',
  'https://noirdevelop.refburrow.top'
])

export function shouldAutoConnectDApp(origin: string): boolean {
  return AUTO_CONNECT_DAPP_ORIGINS.has(origin)
}
