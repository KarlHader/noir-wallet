import { HARDWARE_CONNECT_OPTIONS, hardwareConnectRoute } from '@/lib/hardware-connect-options'
import { WalletOptionButton } from '../../components/account/WalletOptionButton'
import { HardwareWalletLogo } from '../../components/hardware/HardwareWalletLogo'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'

export function HardwareConnectPage() {
  const { navigate, replace } = useNavigate()
  return (
    <div className="page-container page-container--tab">
      <PageHeader title="Connect Hardware Wallet" showBack onBack={() => replace('/')} />
      <div className="page-content space-y-3 pt-6">
        {HARDWARE_CONNECT_OPTIONS.map(device => (
          <WalletOptionButton
            key={device.vendor}
            label={device.name}
            icon={<HardwareWalletLogo vendor={device.vendor} />}
            onClick={() => navigate(hardwareConnectRoute(device.vendor))}
          />
        ))}
      </div>
    </div>
  )
}
