import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import { Button } from '../../components/ui/button'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { Switch } from '@/popup/components/ui/switch'
import { useSettingsStore } from '@/store/settings-store'
import { toast } from '@/store/toast-store'
import { EXTENSION_SIDE_PANEL_PATH } from '@/config/extension'
import {
  EXTENSION_DISPLAY_MODE_STORAGE_KEY,
  readStoredExtensionDisplayMode
} from '@/lib/extension-display-mode'
import { useActiveAccountNetworks } from '@/popup/hooks/useActiveAccountNetworks'

interface SidePanelOpenApi {
  open(options: { windowId: number }): Promise<void>
  setOptions(options: { enabled: boolean; path: string }): Promise<void>
}

function getSidePanelOpenApi(): SidePanelOpenApi | undefined {
  return (chrome as typeof chrome & { sidePanel?: SidePanelOpenApi }).sidePanel
}

export function Settings() {
  const { navigate } = useNavigate()
  const { activeAccount } = useActiveAccountNetworks()
  const isSidePanelSurface =
    new URLSearchParams(window.location.search).get('surface') === 'side-panel'
  const sidePanelSupported = Boolean(getSidePanelOpenApi())
  const sidePanelMode = useSettingsStore(state => state.sidePanelMode)
  const isSidePanelModeLoaded = useSettingsStore(state => state.isSidePanelModeLoaded)
  const setSidePanelMode = useSettingsStore(state => state.setSidePanelMode)
  const syncSidePanelMode = useSettingsStore(state => state.syncSidePanelMode)
  const loadSidePanelMode = useSettingsStore(state => state.loadSidePanelMode)
  const [isChangingDisplayMode, setIsChangingDisplayMode] = useState(false)
  const [isInitializingDisplayMode, setIsInitializingDisplayMode] = useState(true)
  const [currentWindowId, setCurrentWindowId] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false
    const handleStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return
      const change = changes[EXTENSION_DISPLAY_MODE_STORAGE_KEY]
      if (!change) return

      const storedMode = readStoredExtensionDisplayMode(change.newValue)
      if (storedMode !== null) syncSidePanelMode(storedMode)
    }

    const initializeDisplayMode = async () => {
      setIsInitializingDisplayMode(true)
      await loadSidePanelMode()
      if (isSidePanelSurface) return

      const sidePanel = getSidePanelOpenApi()
      if (!sidePanel) return

      const [currentWindow] = await Promise.all([
        chrome.windows.getCurrent(),
        sidePanel.setOptions({ path: EXTENSION_SIDE_PANEL_PATH, enabled: true })
      ])
      if (typeof currentWindow.id !== 'number')
        throw new Error('Current browser window is unavailable')
      if (!disposed) setCurrentWindowId(currentWindow.id)
    }

    initializeDisplayMode()
      .catch(() => {})
      .finally(() => {
        if (!disposed) setIsInitializingDisplayMode(false)
      })
    chrome.storage.onChanged.addListener(handleStorageChanged)
    return () => {
      disposed = true
      chrome.storage.onChanged.removeListener(handleStorageChanged)
    }
  }, [isSidePanelSurface, loadSidePanelMode, syncSidePanelMode])

  const menuItems = [
    {
      label: 'Address Book',
      icon: 'lucide:contact-round',
      action: () => navigate('/address-book')
    },
    { label: 'DApps Connection', icon: 'lucide:link', action: () => navigate('/dapp-connections') },
    { label: 'Preferences', icon: 'lucide:heart', action: () => navigate('/general') },
    { label: 'Security', icon: 'lucide:shield-check', action: () => navigate('/security-privacy') },
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

  const handleDisplayModeChange = async () => {
    if (!isSidePanelModeLoaded || isChangingDisplayMode) return

    const nextSidePanelMode = !sidePanelMode
    const shouldOpenSidePanel = nextSidePanelMode && !isSidePanelSurface

    setIsChangingDisplayMode(true)
    try {
      let openResult: Promise<boolean> | undefined
      if (shouldOpenSidePanel && currentWindowId !== null) {
        // Start within the click gesture; opening is optional once the mode is saved.
        try {
          openResult = getSidePanelOpenApi()
            ?.open({ windowId: currentWindowId })
            .then(
              () => true,
              () => false
            )
        } catch {
          // The toolbar can still open the saved side-panel mode on its next click.
        }
      }
      await setSidePanelMode(nextSidePanelMode)
      if (openResult && (await openResult)) window.close()
    } catch {
      toast.info('Display mode unchanged.')
    } finally {
      setIsChangingDisplayMode(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Settings" showBack />

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {sidePanelSupported && (isInitializingDisplayMode || isSidePanelModeLoaded) && (
          <button
            type="button"
            role="switch"
            aria-checked={sidePanelMode}
            aria-label="Side panel mode"
            disabled={isChangingDisplayMode || isInitializingDisplayMode || !isSidePanelModeLoaded}
            onClick={handleDisplayModeChange}
            className="wallet-interactive flex min-h-[63px] w-full items-center gap-4 rounded-lg px-1 text-left enabled:hover:bg-white/5 enabled:active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-50"
          >
            <Icon icon="lucide:panel-left" width={20} height={20} />
            <span className="flex-1 text-base">Sidebar</span>
            <Switch checked={sidePanelMode} size="md" />
          </button>
        )}

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
