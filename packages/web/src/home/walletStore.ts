export const WALLET_STORE_URL =
  'https://chromewebstore.google.com/detail/noir-wallet/mfoghjbpfanobmnoemoepenjjcmfpmdn'

export const walletLinkProps = {
  href: WALLET_STORE_URL,
  target: '_blank',
  rel: 'noopener noreferrer'
} as const

/** Where the live site is served; its Docs links go to the live docs. */
const LIVE_HOSTS = new Set(['www.zknoir.com', 'zknoir.com'])

/**
 * The docs that go with a copy of the site: the live site links to the live docs, and anything
 * else (the branch preview, local builds) to the docs preview of this branch. Both open on the
 * docs home page.
 */
export function docsUrlFor(hostname: string): string {
  return LIVE_HOSTS.has(hostname)
    ? 'https://docs.zknoir.com/'
    : 'https://feat-web-redesign.noir-wallet-docs.pages.dev/'
}

export const docsLinkProps = {
  href: docsUrlFor(typeof window === 'undefined' ? '' : window.location.hostname),
  target: '_blank',
  rel: 'noopener noreferrer'
} as const
