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
import { SocialLinks } from '@/popup/components/common/SocialLinks'

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
    { label: 'General', action: () => navigate('/general') },
    { label: 'Networks', action: () => navigate('/networks') },
    { label: 'Address Book', action: () => navigate('/address-book') },
    { label: 'Default EVM Wallet', action: () => navigate('/default-evm-wallet') },
    { label: 'Security & Privacy', action: () => navigate('/security-privacy') },
    { label: 'Developer Settings', action: () => navigate('/developer-settings') },
    { label: 'About', action: () => navigate('/about') },
    { label: 'Help', action: () => navigate('/help') },
    ...(activeAccount?.walletSource.kind === 'software' &&
    activeAccount.networks.some(network => network.chain.family === 'zcash')
      ? [{ label: 'Zcash voting', action: () => navigate('/voting') }]
      : [])
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

      <div className="page-content space-y-2">
        {sidePanelSupported && (isInitializingDisplayMode || isSidePanelModeLoaded) && (
          <button
            type="button"
            role="switch"
            aria-checked={sidePanelMode}
            aria-label="Side panel mode"
            disabled={isChangingDisplayMode || isInitializingDisplayMode || !isSidePanelModeLoaded}
            onClick={handleDisplayModeChange}
            className="w-full p-4 bg-card rounded-xl hover:bg-white/5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait text-left"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm">Side panel mode</div>
                <div className="text-xs text-muted mt-1">
                  {sidePanelMode
                    ? 'Toolbar icon opens the Chrome side panel'
                    : isSidePanelModeLoaded
                      ? 'Toolbar icon opens the wallet popup'
                      : 'Loading wallet display mode'}
                </div>
              </div>
              <Switch checked={sidePanelMode} />
            </div>
          </button>
        )}

        {menuItems.map((item, index) => (
          <button
            key={index}
            onClick={item.action}
            className="w-full p-4 bg-card rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm">{item.label}</span>
              <Icon icon="lucide:chevron-right" width={16} height={16} className="text-muted" />
            </div>
          </button>
        ))}
      </div>

      <div className="page-footer space-y-3">
        <SocialLinks />
        <Button onClick={handleLock} variant="outline" className="w-full h-[45px]">
          <Icon icon="lucide:lock" width={16} height={16} className="mr-2" />
          Lock Wallet
        </Button>
      </div>
    </div>
  )
}
