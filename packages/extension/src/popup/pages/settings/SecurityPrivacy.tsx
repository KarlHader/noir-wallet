import { Icon } from '@iconify/react'
import { getResponseErrorMessage } from '@/lib/errors'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { useNavigate } from '../../provider/Router'
import {
  DEFAULT_GOOGLE_ANALYTICS_ENABLED,
  isGoogleAnalyticsEnabled,
  setGoogleAnalyticsEnabled
} from '@/lib/analytics/preferences'
import { Switch } from '@/popup/components/ui/switch'
import { toast } from '@/store/toast-store'
import { SETTINGS_STORAGE_KEY } from '@/lib/wallet-settings-storage'
import { sendZeroIndexerNodeMessage } from '@/popup/services/zero-indexer-node-client'
import { selectedZeroIndexerNodeLabel } from '@/popup/services/zero-indexer-node-model'
import {
  parseZeroIndexerEnabled,
  ZERO_INDEXER_NODES_STORAGE_KEY,
  ZERO_INDEXER_RUNTIME_STORAGE_KEY
} from '@/infrastructure/chains/zero-indexer-preferences'

export function SecurityPrivacy() {
  const { navigate } = useNavigate()
  const [analyticsEnabled, setAnalyticsEnabled] = useState(DEFAULT_GOOGLE_ANALYTICS_ENABLED)
  const [isLoaded, setIsLoaded] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [zeroIndexerEnabled, setZeroIndexerEnabled] = useState(false)
  const [zeroIndexerLoaded, setZeroIndexerLoaded] = useState(false)
  const [zeroIndexerLoading, setZeroIndexerLoading] = useState(false)
  const [zeroIndexerLoadError, setZeroIndexerLoadError] = useState(false)
  const [zeroIndexerSaving, setZeroIndexerSaving] = useState(false)
  const [broadcastNode, setBroadcastNode] = useState('Auto')
  const enabledRevision = useRef(0)
  const enabledLoadRevision = useRef(0)

  const loadZeroIndexerEnabled = useCallback(async () => {
    const requestRevision = ++enabledLoadRevision.current
    const initialRevision = enabledRevision.current
    setZeroIndexerLoading(true)
    setZeroIndexerLoadError(false)
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_ZERO_INDEXER_ENABLED' })
      if (requestRevision !== enabledLoadRevision.current) return
      if (!response?.success || typeof response.enabled !== 'boolean') {
        throw new Error('Could not load private broadcast preference')
      }
      if (enabledRevision.current === initialRevision) setZeroIndexerEnabled(response.enabled)
      setZeroIndexerLoaded(true)
    } catch {
      if (requestRevision === enabledLoadRevision.current) setZeroIndexerLoadError(true)
    } finally {
      if (requestRevision === enabledLoadRevision.current) setZeroIndexerLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void isGoogleAnalyticsEnabled().then(enabled => {
      if (active) {
        setAnalyticsEnabled(enabled)
        setIsLoaded(true)
      }
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let nodeRevision = 0
    const loadNode = async () => {
      const revision = ++nodeRevision
      try {
        const { status } = await sendZeroIndexerNodeMessage({
          type: 'GET_ZERO_INDEXER_NODE_STATUS'
        })
        if (active && revision === nodeRevision)
          setBroadcastNode(selectedZeroIndexerNodeLabel(status))
      } catch {
        // The node page provides retry and error feedback.
      }
    }
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[SETTINGS_STORAGE_KEY]) {
        enabledRevision.current += 1
        enabledLoadRevision.current += 1
        setZeroIndexerEnabled(parseZeroIndexerEnabled(changes[SETTINGS_STORAGE_KEY].newValue))
        setZeroIndexerLoaded(true)
        setZeroIndexerLoading(false)
        setZeroIndexerLoadError(false)
      }
      if (
        (area === 'local' &&
          (changes[ZERO_INDEXER_NODES_STORAGE_KEY] || changes[ZERO_INDEXER_RUNTIME_STORAGE_KEY])) ||
        (area === 'session' && changes[ZERO_INDEXER_RUNTIME_STORAGE_KEY])
      )
        void loadNode()
    }
    chrome.storage.onChanged.addListener(onChanged)
    void loadZeroIndexerEnabled()
    void loadNode()
    return () => {
      active = false
      enabledLoadRevision.current += 1
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [loadZeroIndexerEnabled])

  const handleZeroIndexerToggle = async () => {
    if (!zeroIndexerLoaded || zeroIndexerSaving) return
    const revision = enabledRevision.current
    setZeroIndexerSaving(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SET_ZERO_INDEXER_ENABLED',
        enabled: !zeroIndexerEnabled
      })
      if (!response?.success || typeof response.enabled !== 'boolean') {
        throw new Error(
          getResponseErrorMessage(response) || 'Could not update private broadcast preference'
        )
      }
      if (enabledRevision.current === revision) setZeroIndexerEnabled(response.enabled)
      if (response.warning) toast.error(response.warning)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not update private broadcast preference'
      )
    } finally {
      setZeroIndexerSaving(false)
    }
  }

  const handleAnalyticsToggle = async () => {
    if (!isLoaded || isSaving) return
    const nextEnabled = !analyticsEnabled
    setAnalyticsEnabled(nextEnabled)
    setIsSaving(true)
    try {
      await setGoogleAnalyticsEnabled(nextEnabled)
    } catch {
      setAnalyticsEnabled(!nextEnabled)
      toast.error('Could not update analytics preference')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Security & Privacy" showBack />

      <div className="page-content space-y-5">
        <div>
          <p className="text-xs text-muted mb-2 px-1">Security</p>
          <button
            onClick={() => navigate('/change-password')}
            className="w-full p-4 bg-card rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm">Change Password</span>
              <Icon icon="lucide:chevron-right" width={16} height={16} className="text-muted" />
            </div>
          </button>
        </div>

        <div>
          <p className="text-xs text-muted mb-2 px-1">Privacy</p>
          <section
            aria-label="Private broadcast settings"
            className="mb-3 overflow-hidden rounded-lg border border-white/10 bg-card"
          >
            <button
              type="button"
              role="switch"
              aria-checked={zeroIndexerEnabled}
              aria-label="Private broadcast"
              disabled={!zeroIndexerLoaded || zeroIndexerLoading || zeroIndexerSaving}
              onClick={() => void handleZeroIndexerToggle()}
              className="flex w-full items-center justify-between gap-4 p-4 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
            >
              <span className="text-sm">Private broadcast</span>
              <Switch checked={zeroIndexerEnabled} />
            </button>
            <button
              type="button"
              onClick={() => navigate('/zero-indexer-nodes')}
              className="flex w-full items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-left transition-colors hover:bg-white/5"
            >
              <span className="text-sm">Broadcast nodes</span>
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="max-w-28 truncate">{broadcastNode}</span>
                <Icon icon="lucide:chevron-right" className="size-4 shrink-0" />
              </span>
            </button>
          </section>
          {zeroIndexerLoadError && (
            <InlineError
              message="Could not load private broadcast preference"
              onRetry={() => void loadZeroIndexerEnabled()}
              retrying={zeroIndexerLoading}
              className="mb-3"
            />
          )}
          <button
            type="button"
            role="switch"
            aria-checked={analyticsEnabled}
            aria-label="Share Google Analytics"
            disabled={!isLoaded || isSaving}
            onClick={handleAnalyticsToggle}
            className="w-full p-4 bg-card rounded-xl border border-white/10 hover:bg-white/5 cursor-pointer transition-colors disabled:cursor-wait disabled:opacity-70"
          >
            <div className="flex items-start justify-between gap-4 text-left">
              <div>
                <div className="text-sm">Share Google Analytics</div>
                <div className="text-xs text-muted mt-1 leading-relaxed">
                  Noir Wallet service metrics continue when this is off.
                </div>
              </div>
              <div className="pt-0.5">
                <Switch checked={analyticsEnabled} />
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}
