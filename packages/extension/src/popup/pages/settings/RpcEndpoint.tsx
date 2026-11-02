import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { DEFAULT_NETWORK, getNetworkConfig } from '@/lib/runtime-network'
import {
  ensureRpcEndpointPreferencesLoaded,
  getRpcEndpointGroups,
  refreshRpcEndpointRegistry
} from '@/infrastructure/chains/rpc-endpoints'
import {
  RPC_DEFAULT_ENDPOINTS,
  type RpcEndpointChain,
  type RpcEndpointGroup,
  type RpcEndpointOption
} from '@/config/rpc-endpoints'
import {
  findChainEndpointOverride,
  withoutSavedChainRpcEndpoint,
  type ChainEndpointSettings,
  type CustomChainRpcEndpoint
} from '@/core/chains/chain-endpoint-settings'
import { getZcashChainId } from '@/core/chains/registry'
import { useSettingsStore } from '@/store/settings-store'
import { toast } from '@/store/toast-store'
import { EndpointOption } from '../../components/common/EndpointOption'
import { EndpointLatencyBadge as PingBadge } from '../../components/common/EndpointStatus'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { chainEndpointSettingsClient } from '../../services/chain-endpoint-settings-client'
import { cn } from '@/lib/utils'
import {
  buildRpcChainOptions,
  buildZcashRpcChainOption,
  type RpcChainOption
} from '@/popup/services/chain-settings-options'
import {
  buildRpcSelectionSettings,
  getRpcAutoFirstEndpoint,
  getSavedRpcEndpoints,
  isSameRpcUrl
} from '@/popup/services/rpc-endpoint-model'
import {
  buildRpcProbeTargets,
  probeRpcTargets,
  rpcProbeKey
} from '@/popup/services/rpc-endpoint-probe'

type PingResult =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly latencyMs: number }
  | { readonly status: 'unreachable' }

const isFixedTestnetEndpoint = DEFAULT_NETWORK === 'testnet'
const fixedTestnetEndpointGroups: readonly RpcEndpointGroup[] | null = isFixedTestnetEndpoint
  ? [
      {
        chain: 'zcash',
        label: 'Zcash Testnet',
        iconChain: 'zec',
        options: [
          {
            ...RPC_DEFAULT_ENDPOINTS.zcash.testnet,
            url: getNetworkConfig('testnet').rpcUrl
          }
        ]
      }
    ]
  : null

function pingKey(chain: RpcEndpointChain, optionId: string): string {
  return `${chain}:${optionId}`
}

function CustomRpcSection({
  endpoints,
  selectedUrl,
  option,
  pings,
  disabled,
  onAdd,
  onSelect,
  onRemove
}: {
  readonly endpoints: readonly CustomChainRpcEndpoint[]
  readonly selectedUrl?: string
  readonly option: RpcChainOption
  readonly pings: Record<string, PingResult>
  readonly disabled: boolean
  readonly onAdd: () => void
  readonly onSelect: (rpc: CustomChainRpcEndpoint) => void
  readonly onRemove: (rpc: CustomChainRpcEndpoint) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Custom RPC</h3>
        <Button size="sm" variant="outline" className="h-8" disabled={disabled} onClick={onAdd}>
          <Icon icon="lucide:plus" className="size-4" /> Add
        </Button>
      </div>
      {endpoints.map(rpc => (
        <div key={rpc.url} className="flex min-w-0 items-center border-b border-border/60">
          <button
            type="button"
            aria-label={`Use ${rpc.label} RPC`}
            aria-pressed={selectedUrl !== undefined && isSameRpcUrl(selectedUrl, rpc.url)}
            disabled={disabled}
            onClick={() => onSelect(rpc)}
            className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{rpc.label}</span>
              <span className="block truncate font-mono text-[11px] text-muted">
                {rpc.url.replace(/^https?:\/\//, '')}
              </span>
            </span>
            <PingBadge result={pings[rpcProbeKey({ option, url: rpc.url })]} />
            {selectedUrl !== undefined && isSameRpcUrl(selectedUrl, rpc.url) && (
              <Icon icon="lucide:check" className="size-4 shrink-0 text-primary" />
            )}
          </button>
          <button
            type="button"
            title={`Remove ${rpc.label}`}
            aria-label={`Remove ${rpc.label}`}
            disabled={disabled}
            onClick={() => onRemove(rpc)}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:text-danger"
          >
            <Icon icon="lucide:trash-2" className="size-4" />
          </button>
        </div>
      ))}
      {endpoints.length === 0 && <p className="text-xs text-muted">No custom endpoints saved.</p>}
    </div>
  )
}

export function RpcEndpoint({ chainId }: { readonly chainId: string }) {
  const persistedSettings = useSettingsStore(state => state.chainEndpointSettings)
  const isLoaded = useSettingsStore(state => state.isLoaded)
  const setSettings = useSettingsStore(state => state.setChainEndpointSettings)
  const rpcEndpointPreferences = useSettingsStore(state => state.rpcEndpointPreferences)
  const loadSettings = useSettingsStore(state => state.loadSettings)
  // Keep background results local so delayed store rehydration cannot replace the editor snapshot.
  const [currentSettings, setCurrentSettings] = useState<ChainEndpointSettings | null>(null)
  const settings = currentSettings ?? persistedSettings
  const [editing, setEditing] = useState<RpcChainOption | null>(null)
  const [url, setUrl] = useState('')
  const [customName, setCustomName] = useState('')
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    readonly chainId: string
    readonly rpc: CustomChainRpcEndpoint
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [displayedRpcEndpointGroups, setDisplayedRpcEndpointGroups] = useState<
    readonly RpcEndpointGroup[]
  >(fixedTestnetEndpointGroups ?? getRpcEndpointGroups())
  const [editingRegistryChain, setEditingRegistryChain] = useState<RpcEndpointChain | null>(null)
  const [pings, setPings] = useState<Record<string, PingResult>>({})
  const [applyingKey, setApplyingKey] = useState<string | null>(null)
  const [openingChainId, setOpeningChainId] = useState<string | null>(null)
  const [registryVersion, setRegistryVersion] = useState(0)
  const settingsOperation = useRef(0)
  const isZcash = chainId === getZcashChainId(DEFAULT_NETWORK)

  useEffect(() => {
    loadSettings().catch(() => {})
    if (isFixedTestnetEndpoint) return
    let active = true
    ensureRpcEndpointPreferencesLoaded()
      .then(preferences => {
        if (!active) return preferences
        useSettingsStore.setState({ rpcEndpointPreferences: preferences })
        setDisplayedRpcEndpointGroups(getRpcEndpointGroups())
        return refreshRpcEndpointRegistry()
      })
      .then(preferences => {
        if (!active) return
        useSettingsStore.setState({ rpcEndpointPreferences: preferences })
        setDisplayedRpcEndpointGroups(getRpcEndpointGroups())
        setRegistryVersion(value => value + 1)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [loadSettings])

  useEffect(
    () => () => {
      settingsOperation.current += 1
    },
    []
  )

  useEffect(() => {
    settingsOperation.current += 1
    setCurrentSettings(null)
    setEditing(null)
    setEditingRegistryChain(null)
    setDeleteTarget(null)
    setOpeningChainId(null)
    setApplyingKey(null)
    setSaving(false)
    setPings({})
  }, [chainId])

  const editingRegistryGroup = useMemo(
    () => displayedRpcEndpointGroups.find(group => group.chain === editingRegistryChain) ?? null,
    [displayedRpcEndpointGroups, editingRegistryChain]
  )

  const options = useMemo(() => buildRpcChainOptions(settings), [settings, registryVersion])
  const zcashOption = useMemo(
    () => buildZcashRpcChainOption(displayedRpcEndpointGroups),
    [displayedRpcEndpointGroups]
  )
  const zcashCustom = findChainEndpointOverride(settings, zcashOption.chainId)?.rpc
  const option = isZcash ? zcashOption : options.find(item => item.chainId === chainId)
  const selectedRpc =
    option && !(isZcash && isFixedTestnetEndpoint)
      ? findChainEndpointOverride(settings, option.chainId)?.rpc
      : undefined
  const selectedAutoEndpoint = option && getRpcAutoFirstEndpoint(option)
  const editingRpc = editing ? findChainEndpointOverride(settings, editing.chainId)?.rpc : undefined
  const editingAutoEndpoint = editing ? getRpcAutoFirstEndpoint(editing) : null
  const zcashAutoEndpoint =
    editingRegistryGroup?.options.find(option => option.id === rpcEndpointPreferences.zcash) ??
    editingRegistryGroup?.options[0]
  const zcashGroup = displayedRpcEndpointGroups.find(group => group.chain === 'zcash')
  const zcashSelectedEndpoint =
    zcashGroup?.options.find(endpoint => endpoint.id === rpcEndpointPreferences.zcash) ??
    zcashGroup?.options[0]

  useEffect(() => {
    const targets = buildRpcProbeTargets({
      settings,
      zcashOption,
      editingRegistryGroup,
      editing
    })
    const controller = new AbortController()
    setPings(current =>
      Object.fromEntries([
        ...Object.entries(current),
        ...targets.map(target => [rpcProbeKey(target), { status: 'pending' as const }])
      ])
    )
    void probeRpcTargets(targets, controller.signal, (key, latencyMs) => {
      setPings(current => ({
        ...current,
        [key]: latencyMs === null ? { status: 'unreachable' } : { status: 'ok', latencyMs }
      }))
    })
    return () => controller.abort()
  }, [zcashOption, zcashCustom?.url, settings, editingRegistryGroup, editing])

  const handleZcashSelect = async (chain: RpcEndpointChain, option: RpcEndpointOption) => {
    if (isFixedTestnetEndpoint || applyingKey || saving) return
    const operation = ++settingsOperation.current
    const key = pingKey(chain, option.id)
    setApplyingKey(key)
    try {
      const saved = await chainEndpointSettingsClient.apply(
        buildRpcSelectionSettings(settings, zcashOption, option.url),
        settings
      )
      if (operation !== settingsOperation.current) return
      setCurrentSettings(saved)
      setSettings(saved)
      toast.success('RPC Saved', `${option.label} is now selected`)
    } catch (error) {
      if (operation !== settingsOperation.current) return
      toast.error(
        'RPC Validation Failed',
        error instanceof Error ? error.message : 'RPC unavailable'
      )
    } finally {
      if (operation === settingsOperation.current) setApplyingKey(null)
    }
  }

  const selectZcashAuto = async () => {
    if (isFixedTestnetEndpoint || applyingKey || saving) return
    const operation = ++settingsOperation.current
    setApplyingKey('zcash:auto')
    try {
      const saved = await chainEndpointSettingsClient.apply(
        buildRpcSelectionSettings(settings, zcashOption),
        settings
      )
      if (operation !== settingsOperation.current) return
      setCurrentSettings(saved)
      setSettings(saved)
      toast.success('Auto RPC Enabled')
    } catch (error) {
      if (operation !== settingsOperation.current) return
      toast.error(
        'RPC Update Failed',
        error instanceof Error ? error.message : 'Could not enable Auto'
      )
    } finally {
      if (operation === settingsOperation.current) setApplyingKey(null)
    }
  }

  const openWithCurrentSettings = async (
    chainId: string,
    showEditor: (current: ChainEndpointSettings) => void
  ) => {
    if (openingChainId !== null) return
    const operation = ++settingsOperation.current
    setOpeningChainId(chainId)
    try {
      const current = await chainEndpointSettingsClient.read()
      if (operation !== settingsOperation.current) return
      setCurrentSettings(current)
      showEditor(current)
    } catch (error) {
      if (operation !== settingsOperation.current) return
      toast.error(
        'RPC Settings Unavailable',
        error instanceof Error ? error.message : 'Could not load RPC settings'
      )
    } finally {
      if (operation === settingsOperation.current) setOpeningChainId(null)
    }
  }

  const openRegistryEditor = (chain: RpcEndpointChain) =>
    openWithCurrentSettings(chainId, () => setEditingRegistryChain(chain))

  const openChainEditor = (option: RpcChainOption) =>
    openWithCurrentSettings(option.chainId, current => {
      const refreshed = buildRpcChainOptions(current).find(item => item.chainId === option.chainId)
      if (refreshed) openEditor(refreshed)
    })

  const openEditor = (option: RpcChainOption, add = false) => {
    settingsOperation.current += 1
    setOpeningChainId(null)
    setUrl('')
    setCustomName('')
    setAdding(add)
    setEditing(option)
  }

  const saveSettings = async (
    next: ChainEndpointSettings,
    expectedSettings: ChainEndpointSettings
  ): Promise<boolean> => {
    if (saving) return false
    const operation = ++settingsOperation.current
    setOpeningChainId(null)
    setSaving(true)
    try {
      const saved = await chainEndpointSettingsClient.apply(next, expectedSettings)
      if (operation !== settingsOperation.current) return false
      setCurrentSettings(saved)
      setSettings(saved)
      return true
    } catch (error) {
      if (operation !== settingsOperation.current) return false
      toast.error(
        'RPC Validation Failed',
        error instanceof Error ? error.message : 'The endpoint could not be verified.'
      )
      return false
    } finally {
      if (operation === settingsOperation.current) setSaving(false)
    }
  }

  const apply = async (customUrl?: string) => {
    if (!editing || saving) return
    try {
      const next = buildRpcSelectionSettings(settings, editing, customUrl, customName, adding)
      if (!(await saveSettings(next, settings))) return
      toast.success(
        customUrl === undefined ? 'Auto RPC Enabled' : 'RPC Saved',
        customUrl === undefined
          ? `${editing.label} will use available managed endpoints.`
          : `${editing.label} will prefer the selected endpoint.`
      )
      setEditing(null)
    } catch (error) {
      toast.error(
        'RPC Validation Failed',
        error instanceof Error ? error.message : 'The endpoint could not be verified.'
      )
    }
  }

  const remove = async () => {
    if (!deleteTarget || saving) return
    const next = withoutSavedChainRpcEndpoint(settings, deleteTarget.chainId, deleteTarget.rpc.url)
    if (await saveSettings(next, settings)) {
      toast.success('Custom RPC Removed')
      setDeleteTarget(null)
    }
  }

  const selectZcashCustom = async (rpc: CustomChainRpcEndpoint) => {
    if (saving || applyingKey) return
    if (
      await saveSettings(
        buildRpcSelectionSettings(settings, zcashOption, rpc.url, rpc.label, true),
        settings
      )
    ) {
      toast.success('RPC Saved', `${rpc.label} is now in use`)
    }
  }

  return (
    <>
      {option && (
        <button
          type="button"
          aria-label="RPC Endpoint"
          disabled={!isLoaded || openingChainId !== null || saving || applyingKey !== null}
          onClick={() => void (isZcash ? openRegistryEditor('zcash') : openChainEditor(option))}
          className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-3 text-left transition-colors hover:border-primary/30 disabled:opacity-50"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">RPC Endpoint</span>
            <span className="block truncate text-xs text-muted">
              {!isLoaded
                ? 'Loading...'
                : (selectedRpc?.label ??
                  (isZcash
                    ? isFixedTestnetEndpoint
                      ? (zcashSelectedEndpoint?.label ?? 'Default')
                      : 'Auto'
                    : `Auto · ${selectedAutoEndpoint?.label ?? 'Default'}`))}
              {isLoaded &&
                ` · ${(
                  selectedRpc?.url ??
                  (isZcash ? zcashSelectedEndpoint?.url : selectedAutoEndpoint?.url) ??
                  option.defaultUrl
                ).replace(/^https?:\/\//, '')}`}
            </span>
          </span>
          <Icon icon="lucide:chevron-right" className="size-4 shrink-0 text-muted" />
        </button>
      )}

      <Dialog
        open={editingRegistryGroup !== null}
        onOpenChange={open => {
          if (!open && applyingKey === null) {
            settingsOperation.current += 1
            setOpeningChainId(null)
            setEditingRegistryChain(null)
          }
        }}
      >
        <DialogContent
          position="bottom"
          className="max-h-[88vh] overflow-y-auto"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{editingRegistryGroup?.label} RPC</DialogTitle>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {!isFixedTestnetEndpoint && (
              <button
                type="button"
                aria-label="Use automatic Zcash RPC"
                aria-pressed={!zcashCustom}
                disabled={applyingKey !== null || saving}
                onClick={() => void selectZcashAuto()}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left',
                  !zcashCustom ? 'border-primary/50 bg-primary/5' : 'border-border/60'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Auto</span>
                  {zcashAutoEndpoint && (
                    <span className="block truncate text-[11px] text-muted">
                      Starts with {zcashAutoEndpoint.label} ·{' '}
                      {zcashAutoEndpoint.url.replace(/^https?:\/\//, '')}
                    </span>
                  )}
                </span>
                {!zcashCustom && <Icon icon="lucide:check" className="size-4 text-primary" />}
              </button>
            )}
            {editingRegistryGroup?.options.map(option => {
              const selected =
                isFixedTestnetEndpoint || (zcashCustom && isSameRpcUrl(zcashCustom.url, option.url))
              const isApplying = applyingKey === pingKey(editingRegistryGroup.chain, option.id)
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-label={`Use ${option.label} RPC`}
                  disabled={isFixedTestnetEndpoint || applyingKey !== null || saving}
                  onClick={() => void handleZcashSelect(editingRegistryGroup.chain, option)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed',
                    selected
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/60 hover:border-primary/30'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{option.label}</p>
                    <p className="truncate font-mono text-[11px] text-muted">
                      {option.url.replace(/^https?:\/\//, '')}
                    </p>
                  </div>
                  <PingBadge
                    result={pings[rpcProbeKey({ option: zcashOption, url: option.url })]}
                  />
                  {isApplying ? (
                    <Icon
                      icon="lucide:loader-2"
                      className="size-5 shrink-0 animate-spin text-primary"
                    />
                  ) : (
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-transparent'
                      )}
                    >
                      <Icon icon="lucide:check" className="size-3" />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {!isFixedTestnetEndpoint && (
            <CustomRpcSection
              endpoints={getSavedRpcEndpoints(settings, zcashOption)}
              selectedUrl={zcashCustom?.url}
              option={zcashOption}
              pings={pings}
              disabled={saving || applyingKey !== null}
              onAdd={() => {
                setEditingRegistryChain(null)
                openEditor(zcashOption, true)
              }}
              onSelect={rpc => void selectZcashCustom(rpc)}
              onRemove={rpc => {
                setEditingRegistryChain(null)
                setDeleteTarget({ chainId: zcashOption.chainId, rpc })
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={open => !open && !saving && setEditing(null)}>
        <DialogContent position="bottom" className="flex max-h-[92vh] flex-col gap-3 p-5">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {adding ? `Add ${editing?.label} RPC` : `${editing?.label} RPC`}
            </DialogTitle>
            <DialogDescription className={adding ? undefined : 'sr-only'}>
              {editing?.protocol === 'zcash-lightwalletd'
                ? `Zcash ${DEFAULT_NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet'} gRPC-Web endpoint.`
                : 'HTTPS endpoint. Localhost HTTP is allowed.'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto">
            {adding && (
              <Input
                aria-label="Custom RPC name"
                value={customName}
                maxLength={64}
                onChange={event => setCustomName(event.target.value)}
                placeholder="Name (optional)"
                disabled={saving}
                className="h-11 rounded-lg"
              />
            )}
            {adding && (
              <Input
                aria-label={`${editing?.label ?? ''} RPC URL`}
                type="url"
                value={url}
                disabled={saving}
                onChange={event => setUrl(event.target.value)}
                placeholder="https://rpc.example"
                className="h-11 rounded-lg font-mono text-xs"
              />
            )}
            {!adding && editing && editing.presets && editing.presets.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted">Provider presets</p>
                <div data-testid="provider-presets" className="space-y-2">
                  <button
                    type="button"
                    aria-label="Use automatic RPC"
                    aria-pressed={!editingRpc}
                    disabled={saving}
                    onClick={() => void apply()}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left',
                      !editingRpc ? 'border-primary/50 bg-primary/5' : 'border-border/60'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">Auto</span>
                      <span className="block truncate text-[11px] text-muted">
                        Starts with {editingAutoEndpoint?.label} ·{' '}
                        {editingAutoEndpoint?.url.replace(/^https?:\/\//, '')}
                      </span>
                    </span>
                    {!editingRpc && <Icon icon="lucide:check" className="size-4 text-primary" />}
                  </button>
                  {editing.presets.map(preset => {
                    const selected = isSameRpcUrl(editingRpc?.url ?? '', preset.url)
                    return (
                      <EndpointOption
                        key={preset.id}
                        label={preset.label}
                        url={preset.url}
                        ariaLabel={`Use ${preset.label} RPC`}
                        selected={selected}
                        disabled={saving}
                        onClick={() => void apply(preset.url)}
                      >
                        <PingBadge
                          result={pings[rpcProbeKey({ option: editing, url: preset.url })]}
                        />
                      </EndpointOption>
                    )
                  })}
                </div>
              </div>
            )}
            {!adding && editing && (
              <CustomRpcSection
                endpoints={getSavedRpcEndpoints(settings, editing)}
                selectedUrl={editingRpc?.url}
                option={editing}
                pings={pings}
                disabled={saving}
                onAdd={() => {
                  setAdding(true)
                  setUrl('')
                  setCustomName('')
                }}
                onSelect={rpc => void apply(rpc.url)}
                onRemove={rpc => {
                  setDeleteTarget({ chainId: editing.chainId, rpc })
                  setEditing(null)
                }}
              />
            )}
          </div>
          {adding && (
            <div className="grid shrink-0 grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-11"
                disabled={saving}
                onClick={() => editing && openEditor(editing)}
              >
                Cancel
              </Button>
              <Button
                className="h-11"
                isLoading={saving}
                disabled={!url.trim()}
                onClick={() => void apply(url)}
              >
                Verify & Add
              </Button>
            </div>
          )}
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
              {deleteTarget &&
              findChainEndpointOverride(settings, deleteTarget.chainId)?.rpc?.url ===
                deleteTarget.rpc.url
                ? 'The active endpoint will be removed. The default RPC will be used.'
                : 'This endpoint will be removed from your saved RPC list.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={saving} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" isLoading={saving} onClick={() => void remove()}>
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
