import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Switch } from '@/popup/components/ui/switch'
import { EXTENSION_SIDE_PANEL_PATH } from '@/config/extension'
import {
  EXTENSION_DISPLAY_MODE_STORAGE_KEY,
  readStoredExtensionDisplayMode
} from '@/lib/extension-display-mode'
import { useSettingsStore } from '@/store/settings-store'
import { toast } from '@/store/toast-store'

interface SidePanelOpenApi {
  open(options: { windowId: number }): Promise<void>
  setOptions(options: { enabled: boolean; path: string }): Promise<void>
}

export function SidebarModeToggle({ compact = false }: { readonly compact?: boolean }) {
  const isSidePanelSurface =
    new URLSearchParams(window.location.search).get('surface') === 'side-panel'
  const sidePanel = (chrome as typeof chrome & { sidePanel?: SidePanelOpenApi }).sidePanel
  const sidePanelMode = useSettingsStore(state => state.sidePanelMode)
  const isSidePanelModeLoaded = useSettingsStore(state => state.isSidePanelModeLoaded)
  const setSidePanelMode = useSettingsStore(state => state.setSidePanelMode)
  const syncSidePanelMode = useSettingsStore(state => state.syncSidePanelMode)
  const loadSidePanelMode = useSettingsStore(state => state.loadSidePanelMode)
  const changing = useRef(false)
  const [isChanging, setIsChanging] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [currentWindowId, setCurrentWindowId] = useState<number | null>(null)

  useEffect(() => {
    if (!sidePanel) return
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

    const initialize = async () => {
      await loadSidePanelMode()
      if (isSidePanelSurface || disposed) return
      const [currentWindow] = await Promise.all([
        chrome.windows.getCurrent(),
        sidePanel.setOptions({ path: EXTENSION_SIDE_PANEL_PATH, enabled: true })
      ])
      if (!disposed && typeof currentWindow.id === 'number') setCurrentWindowId(currentWindow.id)
    }

    chrome.storage.onChanged.addListener(handleStorageChanged)
    void initialize()
      .catch(() => {})
      .finally(() => {
        if (!disposed) setInitializing(false)
      })
    return () => {
      disposed = true
      chrome.storage.onChanged.removeListener(handleStorageChanged)
    }
  }, [sidePanel, isSidePanelSurface, loadSidePanelMode, syncSidePanelMode])

  const toggle = async () => {
    if (!isSidePanelModeLoaded || changing.current) return
    const nextMode = !sidePanelMode
    changing.current = true
    setIsChanging(true)
    try {
      let openResult: Promise<boolean> | undefined
      if (nextMode && !isSidePanelSurface && currentWindowId !== null) {
        try {
          openResult = sidePanel?.open({ windowId: currentWindowId }).then(
            () => true,
            () => false
          )
        } catch {}
      }
      await setSidePanelMode(nextMode)
      if (openResult && (await openResult)) window.close()
    } catch {
      toast.info('Display mode unchanged.')
    } finally {
      changing.current = false
      setIsChanging(false)
    }
  }

  if (!sidePanel || (!initializing && !isSidePanelModeLoaded)) return null

  return (
    <button
      type="button"
      role="switch"
      aria-checked={sidePanelMode}
      aria-label="Side panel mode"
      disabled={isChanging || initializing || !isSidePanelModeLoaded}
      onClick={toggle}
      className={`wallet-interactive flex w-full items-center text-left enabled:hover:bg-white/5 enabled:active:bg-white/10 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-50 ${compact ? 'h-10 gap-3 rounded-md px-3 text-sm focus-visible:-outline-offset-2' : 'min-h-[63px] gap-4 rounded-lg px-1 text-base focus-visible:outline-offset-2'}`}
    >
      <Icon icon="lucide:panel-left" width={compact ? 16 : 20} height={compact ? 16 : 20} />
      <span className="flex-1">Sidebar</span>
      <Switch checked={sidePanelMode} size={compact ? 'sm' : 'md'} />
    </button>
  )
}
