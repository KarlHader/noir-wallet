export const WALLET_STORE_URL =
  'https://chromewebstore.google.com/detail/noir-wallet/mfoghjbpfanobmnoemoepenjjcmfpmdn'

export const walletLinkProps = {
  href: WALLET_STORE_URL,
  target: '_blank',
  rel: 'noopener noreferrer'
} as const

export const docsLinkProps = {
  href: 'https://docs.zknoir.com',
  target: '_blank',
  rel: 'noopener noreferrer'
} as const
