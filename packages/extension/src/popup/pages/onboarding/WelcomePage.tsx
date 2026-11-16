import { useEffect } from 'react'
import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import WalletIcon from '@/images/wallet-icon.svg'
import { useNavigate } from '../../provider/Router'
import { useOnboardingStore } from '@/store/onboarding-store'
import { openHardwareConnectTab } from '@/lib/hardware-tab'

export function WelcomePage() {
  const { navigate } = useNavigate()
  const { setMode, reset } = useOnboardingStore()

  useEffect(() => {
    reset()
  }, [reset])

  const handleCreateWallet = () => {
    setMode('create')
    navigate('/onboarding/password')
  }

  const handleImportWallet = () => {
    setMode('import')
    navigate('/onboarding/import-word-count')
  }

  const handleConnectHardware = () => {
    // Camera access requires a full tab; the popup closes when it loses focus
    openHardwareConnectTab()
  }

  return (
    <div className="page-container">
      <PageHeader />

      <div className="flex-1 flex flex-col items-center px-5">
        <div className="my-20">
          <img src={WalletIcon} alt="Wallet" />
        </div>

        <h1 className="text-lg font-semibold text-center mb-3">Welcome to Noir Wallet</h1>

        <p className="text-xs text-muted text-center">Safely manage your assets.</p>

        <div className="w-full mt-auto mb-8 space-y-3">
          <Button onClick={handleCreateWallet} className="w-full h-[45px]">
            Create Wallet
          </Button>

          <Button variant="outline" onClick={handleImportWallet} className="w-full h-[45px]">
            Import wallet
          </Button>

          <Button variant="ghost" onClick={handleConnectHardware} className="w-full h-[45px]">
            <Icon icon="lucide:shield" width={16} height={16} className="mr-2" />
            Connect Hardware Wallet
          </Button>
        </div>
      </div>

      <FloatingIcons />
    </div>
  )
}

function FloatingIcons() {
  return (
    <>
      <div className="absolute top-[137px] left-[88px] opacity-50 text-white">
        <Icon icon="lucide:plus" width={12} height={12} />
      </div>
      <div className="absolute top-[209px] right-[97px] text-white">
        <Icon icon="lucide:plus" width={12} height={12} />
      </div>
      <div className="absolute top-[110px] right-[59px] opacity-50 text-white">
        <Icon icon="lucide:plus" width={12} height={12} />
      </div>
    </>
  )
}
