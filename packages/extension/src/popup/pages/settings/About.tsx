import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import WalletIcon from '@/images/wallet-icon.svg'
import { license } from '../../../../package.json'
import { SocialLinks } from '@/popup/components/common/SocialLinks'

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string

export function About() {
  const { navigate } = useNavigate()
  const version = __APP_VERSION__
  const buildTime = new Date(__BUILD_TIME__).toLocaleDateString()
  const currentYear = new Date().getFullYear()

  return (
    <div className="page-container">
      <PageHeader title="About" showBack />

      <div className="page-content">
        <div className="flex flex-col items-center py-8">
          <div className="flex items-center justify-center mb-4">
            <img src={WalletIcon} alt="Wallet" className="w-20 h-20" />
          </div>

          <h2 className="text-xl font-semibold mb-2">Noir Wallet</h2>
          <p className="text-sm text-muted mb-6">Version {version}</p>

          <p className="text-sm text-center text-muted max-w-xs mb-4">
            A privacy-first multi-chain wallet built for security and ease of use
          </p>

          <div className="mb-8">
            <SocialLinks />
          </div>

          <div className="w-full max-w-xs space-y-2">
            <button
              onClick={() => navigate('/terms-of-use')}
              className="w-full p-4 bg-card rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">Terms of Use</span>
                <Icon icon="lucide:chevron-right" width={16} height={16} className="text-muted" />
              </div>
            </button>

            <div className="p-4 bg-card rounded-xl">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">License</span>
                <span className="text-sm">{license}</span>
              </div>
            </div>

            <div className="p-4 bg-card rounded-xl">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">Build</span>
                <span className="text-sm">{buildTime}</span>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted mt-8">
            © {currentYear} Noir Wallet. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  )
}
