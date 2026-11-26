import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { Download, Github } from 'lucide-react'
import noirWalletLogo from '@/assets/noir-logo.jpg?url'

export const chromeWebStoreUrl =
  'https://chromewebstore.google.com/detail/noir-wallet/mfoghjbpfanobmnoemoepenjjcmfpmdn'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="brand-lockup">
          <img className="brand-mark" src={noirWalletLogo} alt="" />
          <span className="brand-name">Noir Wallet</span>
          <span className="brand-docs">Docs</span>
        </span>
      ),
      url: '/',
      transparentMode: 'top'
    },
    themeSwitch: {
      enabled: false
    },
    links: [
      {
        text: 'Website',
        url: 'https://www.zknoir.com',
        external: true
      },
      {
        type: 'icon',
        text: 'GitHub',
        label: 'GitHub',
        url: 'https://zknoir.com/github',
        icon: <Github />,
        external: true
      },
      {
        type: 'custom',
        secondary: true,
        children: (
          <a className="nav-install" href={chromeWebStoreUrl} target="_blank" rel="noreferrer">
            <Download aria-hidden="true" />
            Install Wallet
          </a>
        )
      }
    ]
  }
}
