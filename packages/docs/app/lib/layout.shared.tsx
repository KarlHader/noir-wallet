import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { Github } from 'lucide-react'
import noirWalletLogo from '../../../extension/public/icons/icon128.png?url'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="brand-lockup">
          <img className="brand-mark" src={noirWalletLogo} alt="" />
          <span>Noir Wallet</span>
        </span>
      ),
      url: '/',
      transparentMode: 'top'
    },
    themeSwitch: {
      enabled: true,
      mode: 'light-dark-system'
    },
    links: [
      {
        type: 'icon',
        text: 'GitHub',
        label: 'GitHub',
        url: 'https://zknoir.com/github',
        icon: <Github />,
        external: true
      }
    ]
  }
}
