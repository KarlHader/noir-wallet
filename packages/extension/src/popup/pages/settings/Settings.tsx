import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import { Button } from '../../components/ui/button'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { SidebarModeToggle } from '@/popup/components/shell/SidebarModeToggle'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'

export function Settings() {
  const { navigate } = useNavigate()
  const { activeAccount } = useActiveAccountNetworks()

  const menuItems = [
    {
      label: 'Address Book',
      icon: 'lucide:contact-round',
      action: () => navigate('/address-book')
    },
    { label: 'DApps Connection', icon: 'lucide:link', action: () => navigate('/dapp-connections') },
    { label: 'General', icon: 'lucide:heart', action: () => navigate('/general') },
    {
      label: 'Security & Privacy',
      icon: 'lucide:shield-check',
      action: () => navigate('/security-privacy')
    },
    { label: 'Networks', icon: 'lucide:radio', action: () => navigate('/networks') },
    {
      label: 'Default EVM Wallet',
      icon: 'lucide:wallet',
      action: () => navigate('/default-evm-wallet')
    },
    {
      label: 'Developer Settings',
      icon: 'lucide:code',
      action: () => navigate('/developer-settings')
    },
    ...(activeAccount?.walletSource.kind === 'software' &&
    activeAccount.networks.some(network => network.chain.family === 'zcash')
      ? [{ label: 'Zcash voting', icon: 'lucide:vote', action: () => navigate('/voting') }]
      : []),
    { label: 'Help', icon: 'lucide:circle-help', action: () => navigate('/help') },
    { label: 'About', icon: 'lucide:info', action: () => navigate('/about') }
  ]

  const handleLock = async () => {
    await zcashWalletRuntimeClient.lock()
    navigate('/unlock', { replace: true })
  }

  return (
    <div className="page-container">
      <PageHeader title="Settings" showBack />

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <SidebarModeToggle />

        {menuItems.map((item, index) => (
          <button
            key={index}
            onClick={item.action}
            className="wallet-interactive flex min-h-[63px] w-full items-center gap-4 rounded-lg px-1 text-left hover:bg-white/5 active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
          >
            <Icon icon={item.icon} width={20} height={20} />
            <span className="flex-1 text-base">{item.label}</span>
            <Icon icon="lucide:chevron-right" width={18} height={18} />
          </button>
        ))}
      </div>

      <div className="page-footer">
        <Button
          onClick={handleLock}
          variant="ghost"
          size="wallet"
          className="w-full font-normal text-danger hover:text-danger"
        >
          <Icon icon="lucide:lock" width={16} height={16} className="mr-2" />
          Lock Wallet
        </Button>
      </div>
    </div>
  )
}
