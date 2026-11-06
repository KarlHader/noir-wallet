const ZKNOIR_APP_ORIGIN = 'https://app.zknoir.com'

const AUTO_CONNECT_DAPP_ORIGINS: ReadonlySet<string> = new Set([ZKNOIR_APP_ORIGIN])

export function shouldAutoConnectDApp(origin: string): boolean {
  return AUTO_CONNECT_DAPP_ORIGINS.has(origin)
}
