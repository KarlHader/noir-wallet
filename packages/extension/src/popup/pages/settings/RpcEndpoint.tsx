import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import {
  ensureRpcEndpointPreferencesLoaded,
  getActiveCustomRpcEndpoints,
  getActiveRpcEndpointModes,
  getRpcEndpointGroups,
  parseRpcEndpointModes,
  type RpcEndpointChain,
  type RpcEndpointModes,
  type RpcEndpointOption,
  type RpcEndpointPreferences
} from '@/config/rpc-endpoints'
import {
  isCustomRpcEndpointId,
  parseCustomRpcEndpoints,
  type CustomRpcEndpoints
} from '@/config/custom-rpc'
import { RPC_FAILOVER_STORAGE_KEY } from '@/config/rpc-failover'
import { probeRpcEndpoint } from '@/config/rpc-registry-client'
import { useSettingsStore } from '@/store/settings-store'
import { toast } from '@/store/toast-store'
import { ChainIcon } from '../../components/common/ChainIcon'
import {
  EndpointLatencyBadge as PingBadge,
  EndpointSelectionIndicator as SelectionIndicator,
  type EndpointProbeResult as PingResult
} from '../../components/common/EndpointStatus'
import { PageHeader } from '../../components/common/PageHeader'
import { cn } from '@/lib/utils'
import { DEFAULT_NETWORK, getNetworkConfig } from '@/config/networks'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'

const isFixedTestnetEndpoint = DEFAULT_NETWORK === 'testnet'
const fixedTestnetEndpointGroups = isFixedTestnetEndpoint
  ? [
      {
        chain: 'zcash' as const,
        label: 'Zcash Testnet',
        iconChain: 'zec',
        options: [
          {
            id: 'deltarpc-testnet',
            label: 'DeltaRPC Testnet',
            url: getNetworkConfig('testnet').rpcUrl
          }
        ]
      }
    ]
  : null

interface RpcSettingsResult {
  preferences: RpcEndpointPreferences
  modes: RpcEndpointModes
  customRpcEndpoints: CustomRpcEndpoints
  selectedEndpointId: string
  latencyMs?: number
  warning?: string
}

interface RpcEndpointStatus {
  mode: 'auto' | 'fixed'
  activeEndpoint: RpcEndpointOption
}

function parseRpcSettingsResult(value: unknown): RpcSettingsResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Background returned an invalid RPC settings result')
  }
  const result = value as Partial<RpcSettingsResult>
  if (
    !result.preferences ||
    typeof result.preferences !== 'object' ||
    typeof result.preferences.zcash !== 'string' ||
    typeof result.selectedEndpointId !== 'string'
  ) {
    throw new Error('Background returned an invalid RPC settings result')
  }
  return {
    preferences: { zcash: result.preferences.zcash },
    modes: parseRpcEndpointModes(result.modes),
    customRpcEndpoints: parseCustomRpcEndpoints(result.customRpcEndpoints),
    selectedEndpointId: result.selectedEndpointId,
    ...(Number.isFinite(result.latencyMs) ? { latencyMs: result.latencyMs } : {}),
    ...(typeof result.warning === 'string' ? { warning: result.warning } : {})
  }
}

function parseRpcEndpointStatus(value: unknown): RpcEndpointStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Background returned an invalid RPC endpoint status')
  }
  const result = value as Partial<RpcEndpointStatus>
  const endpoint = result.activeEndpoint
  if (
    (result.mode !== 'auto' && result.mode !== 'fixed') ||
    !endpoint ||
    typeof endpoint.id !== 'string' ||
    typeof endpoint.label !== 'string' ||
    typeof endpoint.url !== 'string'
  ) {
    throw new Error('Background returned an invalid RPC endpoint status')
  }
  return { mode: result.mode, activeEndpoint: endpoint }
}

function pingKey(chain: RpcEndpointChain, optionId: string): string {
  return `${chain}:${optionId}`
}

export function RpcEndpoint() {
  const {
    rpcEndpointPreferences,
    rpcEndpointModes,
    customRpcEndpoints,
    syncRpcEndpointSettings,
    loadSettings
  } = useSettingsStore()
  const [displayedRpcEndpointGroups, setDisplayedRpcEndpointGroups] = useState(
    fixedTestnetEndpointGroups ?? getRpcEndpointGroups()
  )
  const [pings, setPings] = useState<Record<string, PingResult>>({})
  const [applyingKey, setApplyingKey] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<RpcEndpointOption | null>(null)
  const [activeEndpoint, setActiveEndpoint] = useState<RpcEndpointOption | null>(
    fixedTestnetEndpointGroups?.[0].options[0] ?? null
  )

  const refreshActiveEndpoint = useCallback(async () => {
    if (isFixedTestnetEndpoint) return
    const response = await chrome.runtime.sendMessage({ type: 'GET_RPC_ENDPOINT_STATUS' })
    if (!response?.success) throw new Error(response?.error || 'Failed to read RPC endpoint status')
    setActiveEndpoint(parseRpcEndpointStatus(response.result).activeEndpoint)
  }, [])

  const syncResult = useCallback(
    (value: unknown) => {
      const result = parseRpcSettingsResult(value)
      syncRpcEndpointSettings(result.preferences, result.modes, result.customRpcEndpoints)
      setDisplayedRpcEndpointGroups(getRpcEndpointGroups())
      if (result.latencyMs !== undefined) {
        setPings(previous => ({
          ...previous,
          [pingKey('zcash', result.selectedEndpointId)]: {
            status: 'ok',
            latencyMs: result.latencyMs
          }
        }))
      }
      return result
    },
    [syncRpcEndpointSettings]
  )

  useEffect(() => {
    loadSettings().catch(() => {})
    if (isFixedTestnetEndpoint) return

    ensureRpcEndpointPreferencesLoaded()
      .then(preferences => {
        syncRpcEndpointSettings(
          preferences,
          getActiveRpcEndpointModes(),
          getActiveCustomRpcEndpoints()
        )
        setDisplayedRpcEndpointGroups(getRpcEndpointGroups())
        return refreshActiveEndpoint()
      })
      .catch(() => {})
  }, [loadSettings, refreshActiveEndpoint, syncRpcEndpointSettings])

  useEffect(() => {
    if (isFixedTestnetEndpoint) return
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName === 'session' && changes[RPC_FAILOVER_STORAGE_KEY]) {
        const activeEndpointId = changes[RPC_FAILOVER_STORAGE_KEY].newValue?.activeEndpointId
        const endpoint =
          typeof activeEndpointId === 'string'
            ? getRpcEndpointGroups()
                .flatMap(group => group.options)
                .find(option => option.id === activeEndpointId)
            : undefined
        if (endpoint) {
          setActiveEndpoint(endpoint)
        } else {
          refreshActiveEndpoint().catch(() => {})
        }
      }
    }
    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => chrome.storage.onChanged.removeListener(handleStorageChange)
  }, [refreshActiveEndpoint])

  const refreshPings = useCallback(() => {
    for (const group of displayedRpcEndpointGroups) {
      for (const option of group.options) {
        const key = pingKey(group.chain, option.id)
        setPings(previous => ({ ...previous, [key]: { status: 'pending' } }))
        probeRpcEndpoint(option)
          .then(latencyMs => {
            setPings(previous => ({ ...previous, [key]: { status: 'ok', latencyMs } }))
          })
          .catch(() => {
            setPings(previous => ({ ...previous, [key]: { status: 'unreachable' } }))
          })
      }
    }
  }, [displayedRpcEndpointGroups])

  useEffect(() => {
    refreshPings()
  }, [refreshPings])

  const handleSelect = async (chain: RpcEndpointChain, option: RpcEndpointOption) => {
    if (
      isFixedTestnetEndpoint ||
      applyingKey ||
      (rpcEndpointModes[chain] === 'fixed' && rpcEndpointPreferences[chain] === option.id)
    ) {
      return
    }
    const key = pingKey(chain, option.id)
    setApplyingKey(key)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SELECT_RPC_ENDPOINT',
        chain,
        endpointId: option.id
      })
      if (!response?.success) throw new Error(response?.error || 'Failed to select RPC endpoint')
      const result = syncResult(response.result)
      await refreshActiveEndpoint().catch(() => {})
      if (result.warning) {
        toast.warning('Endpoint Saved', 'Wallet will reconnect with the new endpoint shortly')
      } else {
        toast.success('Fixed RPC Enabled', option.label)
      }
    } catch (error) {
      toast.error(
        isCustomRpcEndpointId(option.id) ? 'RPC Validation Failed' : 'RPC Update Failed',
        error instanceof Error ? error.message : 'The endpoint could not be selected.'
      )
    } finally {
      setApplyingKey(null)
    }
  }

  const handleSelectAuto = async () => {
    if (isFixedTestnetEndpoint || applyingKey || rpcEndpointModes.zcash === 'auto') return
    const key = pingKey('zcash', 'auto')
    setApplyingKey(key)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SELECT_AUTOMATIC_RPC_ENDPOINT',
        chain: 'zcash'
      })
      if (!response?.success) throw new Error(response?.error || 'Failed to enable automatic RPC')
      const result = syncResult(response.result)
      await refreshActiveEndpoint().catch(() => {})
      if (result.warning) {
        toast.warning('Auto RPC Saved', 'Wallet will reconnect to a managed endpoint shortly')
      } else {
        toast.success('Auto RPC Enabled', 'Managed endpoints will fall back automatically')
      }
    } catch (error) {
      toast.error(
        'RPC Update Failed',
        error instanceof Error ? error.message : 'Automatic RPC could not be enabled.'
      )
    } finally {
      setApplyingKey(null)
    }
  }

  const handleAdd = async () => {
    if (saving || !customUrl.trim()) return
    setSaving(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ADD_CUSTOM_RPC_ENDPOINT',
        chain: 'zcash',
        label: customName,
        url: customUrl.trim()
      })
      if (!response?.success) throw new Error(response?.error || 'Failed to add custom RPC')
      const result = syncResult(response.result)
      await refreshActiveEndpoint().catch(() => {})
      setAddOpen(false)
      setCustomName('')
      setCustomUrl('')
      if (result.warning) {
        toast.warning('Custom RPC Saved', 'Wallet will reconnect with the new endpoint shortly')
      } else {
        toast.success('Custom RPC Saved', 'The verified endpoint is now fixed')
      }
    } catch (error) {
      toast.error(
        'RPC Validation Failed',
        error instanceof Error ? error.message : 'The endpoint could not be verified.'
      )
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || saving) return
    setSaving(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'REMOVE_CUSTOM_RPC_ENDPOINT',
        chain: 'zcash',
        endpointId: deleteTarget.id
      })
      if (!response?.success) throw new Error(response?.error || 'Failed to remove custom RPC')
      const result = syncResult(response.result)
      await refreshActiveEndpoint().catch(() => {})
      setDeleteTarget(null)
      if (result.warning) {
        toast.warning('Custom RPC Removed', 'Wallet will reconnect in Auto mode shortly')
      } else if (result.modes.zcash === 'auto') {
        toast.success('Auto RPC Enabled', 'The custom endpoint was removed')
      } else {
        toast.success('Custom RPC Removed', 'The endpoint was removed from this wallet')
      }
    } catch (error) {
      toast.error(
        'Remove Failed',
        error instanceof Error ? error.message : 'The custom endpoint could not be removed.'
      )
    } finally {
      setSaving(false)
    }
  }

  const managedGroups = displayedRpcEndpointGroups.map(group => ({
    ...group,
    options: group.options.filter(option => !isCustomRpcEndpointId(option.id))
  }))

  return (
    <div className="page-container">
      <PageHeader
        title="RPC Endpoint"
        showBack
        action={{
          icon: <Icon icon="lucide:refresh-cw" width={14} height={14} />,
          onClick: refreshPings
        }}
      />

      <div className="page-content space-y-6">
        {managedGroups.map(group => (
          <section key={group.chain} className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex size-6 items-center justify-center overflow-hidden rounded-full bg-white">
                <ChainIcon chain={group.iconChain} className="size-6" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-medium text-white">{group.label}</h2>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl bg-card">
              {!isFixedTestnetEndpoint && (
                <button
                  type="button"
                  aria-label="Use automatic RPC selection"
                  aria-pressed={rpcEndpointModes[group.chain] === 'auto'}
                  disabled={!!applyingKey}
                  onClick={handleSelectAuto}
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2 text-sm text-white">
                      <span>Auto</span>
                      {rpcEndpointModes[group.chain] === 'auto' && activeEndpoint && (
                        <span
                          title={`Currently using ${activeEndpoint.label}`}
                          className="truncate rounded bg-primary/10 px-1.5 py-0.5 text-[10px] leading-4 text-primary"
                        >
                          {activeEndpoint.label}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      Automatically switches when an endpoint is unavailable
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {rpcEndpointModes[group.chain] === 'auto' && (
                      <PingBadge
                        result={
                          activeEndpoint
                            ? pings[pingKey(group.chain, activeEndpoint.id)]
                            : undefined
                        }
                      />
                    )}
                    <SelectionIndicator
                      selected={rpcEndpointModes[group.chain] === 'auto'}
                      applying={applyingKey === pingKey(group.chain, 'auto')}
                    />
                  </span>
                </button>
              )}
              {group.options.map((option, index) => {
                const selected =
                  isFixedTestnetEndpoint ||
                  (rpcEndpointModes[group.chain] === 'fixed' &&
                    rpcEndpointPreferences[group.chain] === option.id)
                const applying = applyingKey === pingKey(group.chain, option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={isFixedTestnetEndpoint || !!applyingKey}
                    onClick={() => handleSelect(group.chain, option)}
                    className={cn(
                      'flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed',
                      (index > 0 || !isFixedTestnetEndpoint) && 'border-t border-white/10'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-white">{option.label}</span>
                      <span className="block truncate text-xs text-muted">
                        {option.url.replace(/^https?:\/\//, '')}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <PingBadge result={pings[pingKey(group.chain, option.id)]} />
                      <SelectionIndicator selected={selected} applying={applying} />
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}

        {!isFixedTestnetEndpoint && (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-medium text-white">Custom RPC</h2>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setAddOpen(true)}>
                <Icon icon="lucide:plus" width={15} height={15} />
                Add
              </Button>
            </div>

            {customRpcEndpoints.zcash.length > 0 ? (
              <div className="overflow-hidden rounded-xl bg-card">
                {customRpcEndpoints.zcash.map((option, index) => {
                  const selected =
                    rpcEndpointModes.zcash === 'fixed' && rpcEndpointPreferences.zcash === option.id
                  const applying = applyingKey === pingKey('zcash', option.id)
                  return (
                    <div
                      key={option.id}
                      className={cn(
                        'flex min-h-11 items-center gap-1',
                        index > 0 && 'border-t border-white/10'
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={selected}
                        disabled={!!applyingKey}
                        onClick={() => handleSelect('zcash', option)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2 text-sm text-white">
                            <span className="truncate">{option.label}</span>
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                              Custom
                            </span>
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {option.url.replace(/^https?:\/\//, '')}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <PingBadge result={pings[pingKey('zcash', option.id)]} />
                          <SelectionIndicator selected={selected} applying={applying} />
                        </span>
                      </button>
                      <button
                        type="button"
                        title={`Remove ${option.label}`}
                        aria-label={`Remove ${option.label}`}
                        disabled={saving || !!applyingKey}
                        onClick={() => setDeleteTarget(option)}
                        className="mr-2 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                      >
                        <Icon icon="lucide:trash-2" width={16} height={16} />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="rounded-xl bg-card/45 px-4 py-3 text-xs text-muted">
                No custom endpoints saved.
              </p>
            )}
          </section>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={open => !saving && setAddOpen(open)}>
        <DialogContent position="bottom">
          <DialogHeader>
            <DialogTitle>Add Custom RPC</DialogTitle>
            <DialogDescription>
              The endpoint must provide Zcash Mainnet through gRPC-Web. HTTPS is required except for
              localhost development.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              aria-label="Custom RPC name"
              value={customName}
              onChange={event => setCustomName(event.target.value)}
              placeholder="Name (optional)"
              className="h-11 rounded-xl"
            />
            <Input
              aria-label="Custom RPC URL"
              type="url"
              value={customUrl}
              onChange={event => setCustomUrl(event.target.value)}
              placeholder="https://rpc.example"
              className="h-11 rounded-xl font-mono text-xs"
            />
          </div>
          <Button
            className="h-11 w-full"
            isLoading={saving}
            disabled={!customUrl.trim()}
            onClick={handleAdd}
          >
            Verify & Add
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => !open && !saving && setDeleteTarget(null)}
      >
        <DialogContent position="bottom">
          <DialogHeader>
            <DialogTitle>Remove Custom RPC?</DialogTitle>
            <DialogDescription>
              {rpcEndpointModes.zcash === 'fixed' &&
              rpcEndpointPreferences.zcash === deleteTarget?.id
                ? 'This fixed endpoint is currently in use. Noir Wallet will return to Auto.'
                : 'This endpoint will be removed from your saved RPC list.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="h-11 flex-1"
              disabled={saving}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11 flex-1"
              isLoading={saving}
              onClick={handleDelete}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
