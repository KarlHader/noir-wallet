import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import type { CustomEvmNetwork } from '@/core/chains/chain-endpoint-settings'
import { resolveEvmFeatureRuntimePolicy } from '@/core/chains/feature-runtime-policy'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { useSettingsStore } from '@/store/settings-store'
import { PageHeader } from '../../components/common/PageHeader'
import { ChainIcon } from '../../components/common/ChainIcon'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { useNavigate } from '../../provider/Router'
import { chainEndpointSettingsClient } from '../../services/chain-endpoint-settings-client'
import {
  buildCustomEvmNetwork,
  customEvmNetworkToForm,
  emptyCustomEvmNetworkForm,
  type CustomEvmNetworkErrors,
  type CustomEvmNetworkField,
  type CustomEvmNetworkForm
} from '../../services/custom-evm-network-model'
import { buildNetworkSettingsOptions } from '../../services/chain-settings-options'
import { RpcEndpoint } from './RpcEndpoint'
import { PreferredExplorer } from './PreferredExplorer'

const fields: readonly {
  key: CustomEvmNetworkField
  label: string
  placeholder?: string
  inputMode?: 'numeric' | 'url'
}[] = [
  { key: 'name', label: 'Network name' },
  { key: 'chainId', label: 'Chain ID', inputMode: 'numeric' },
  { key: 'currencyName', label: 'Native currency name' },
  { key: 'currencySymbol', label: 'Symbol' },
  { key: 'decimals', label: 'Decimals', inputMode: 'numeric' },
  { key: 'rpcUrl', label: 'Default RPC URL', inputMode: 'url', placeholder: 'https://rpc.example' },
  { key: 'explorerUrl', label: 'Explorer URL', inputMode: 'url', placeholder: 'Optional' }
]

export function Networks() {
  const { goBack } = useNavigate()
  const settings = useSettingsStore(state => state.chainEndpointSettings)
  const setSettings = useSettingsStore(state => state.setChainEndpointSettings)
  const loadSettings = useSettingsStore(state => state.loadSettings)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<CustomEvmNetwork | null | undefined>(undefined)
  const [detailChainId, setDetailChainId] = useState<string | null>(null)
  const [form, setForm] = useState<CustomEvmNetworkForm>(emptyCustomEvmNetworkForm)
  const [errors, setErrors] = useState<CustomEvmNetworkErrors>({})
  const [deleteTarget, setDeleteTarget] = useState<CustomEvmNetwork | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef(0)
  const options = useMemo(() => buildNetworkSettingsOptions(settings), [settings])
  const detail = options.find(option => option.chainId === detailChainId)
  const customNetwork = settings.customEvmNetworks.find(
    network => network.chainId === detail?.chainId
  )
  const evmEnabled = resolveEvmFeatureRuntimePolicy(
    __ENABLED_CHAIN_FEATURE_FLAGS__
  ).newOperationsEnabled

  useEffect(() => {
    let alive = true
    void loadSettings()
      .catch(() => {})
      .then(() => chainEndpointSettingsClient.read())
      .then(
        result => {
          if (!alive) return
          setSettings(result)
          setReady(true)
          setLoading(false)
        },
        failure => {
          if (!alive) return
          setError(failure instanceof Error ? failure.message : 'Could not load networks')
          setLoading(false)
        }
      )
    return () => {
      alive = false
      operation.current += 1
    }
  }, [loadSettings, setSettings])

  const retryLoad = async () => {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const result = await chainEndpointSettingsClient.read()
      setSettings(result)
      setReady(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load networks')
    } finally {
      setLoading(false)
    }
  }

  const openEditor = (network: CustomEvmNetwork | null) => {
    setEditing(network)
    setForm(network ? customEvmNetworkToForm(network) : emptyCustomEvmNetworkForm())
    setErrors({})
    setError(null)
  }

  const updateField = (key: CustomEvmNetworkField, value: string) => {
    setForm(currentForm => ({ ...currentForm, [key]: value }))
    setErrors(currentErrors => ({ ...currentErrors, [key]: undefined }))
  }

  const save = async () => {
    if (!ready || busy || editing === undefined) return
    const built = buildCustomEvmNetwork(form, DEFAULT_NETWORK, editing ?? undefined)
    const nextErrors = { ...built.errors }
    if (
      built.network &&
      !editing &&
      settings.customEvmNetworks.some(item => item.chainId === built.network?.chainId)
    ) {
      nextErrors.chainId = 'This chain is already added'
    }
    setErrors(nextErrors)
    if (!built.network || Object.keys(nextErrors).length > 0) return
    const token = ++operation.current
    setBusy(true)
    setError(null)
    try {
      const result = await chainEndpointSettingsClient.saveCustomEvmNetwork(
        built.network,
        editing ?? undefined
      )
      if (token === operation.current) {
        setSettings(result)
        setDetailChainId(built.network.chainId)
        setEditing(undefined)
      }
    } catch (failure) {
      if (token === operation.current)
        setError(failure instanceof Error ? failure.message : 'Could not save network')
    } finally {
      if (token === operation.current) setBusy(false)
    }
  }

  const remove = async () => {
    if (!ready || !deleteTarget || busy) return
    const token = ++operation.current
    setBusy(true)
    setError(null)
    try {
      const result = await chainEndpointSettingsClient.removeCustomEvmNetwork(deleteTarget)
      if (token === operation.current) {
        setSettings(result)
        setDeleteTarget(null)
        setDetailChainId(null)
      }
    } catch (failure) {
      if (token === operation.current)
        setError(failure instanceof Error ? failure.message : 'Could not remove network')
    } finally {
      if (token === operation.current) setBusy(false)
    }
  }

  const back = () => {
    setError(null)
    if (editing !== undefined) setEditing(undefined)
    else if (detailChainId) setDetailChainId(null)
    else goBack()
  }

  return (
    <div className="page-container">
      <PageHeader
        title={
          editing !== undefined
            ? editing
              ? 'Edit Network'
              : 'Add Network'
            : detail
              ? 'Network Details'
              : 'Networks'
        }
        showBack
        onBack={back}
        backDisabled={busy}
        rightContent={
          editing === undefined && customNetwork && ready ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Network options"
                  disabled={busy}
                  className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-card hover:text-foreground"
                >
                  <Icon icon="lucide:ellipsis" className="size-5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => openEditor(customNetwork)}>
                  <Icon icon="lucide:pencil" />
                  Edit Network
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-danger focus:text-danger"
                  onSelect={() => {
                    setError(null)
                    setDeleteTarget(customNetwork)
                  }}
                >
                  <Icon icon="lucide:trash-2" />
                  Remove Network
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />
      <div className="page-content min-h-0 space-y-5">
        {error && !deleteTarget && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {!ready && !loading && (
          <Button size="sm" variant="outline" onClick={() => void retryLoad()}>
            Retry
          </Button>
        )}
        {editing !== undefined ? (
          <div className="space-y-4">
            {fields
              .filter(field => !editing || (field.key !== 'rpcUrl' && field.key !== 'explorerUrl'))
              .map(field => (
                <label key={field.key} className="block space-y-1.5 text-sm">
                  <span>{field.label}</span>
                  <Input
                    value={form[field.key]}
                    onChange={event => updateField(field.key, event.target.value)}
                    disabled={busy || (field.key === 'chainId' && !!editing)}
                    inputMode={field.inputMode}
                    placeholder={field.placeholder}
                    maxLength={field.key === 'rpcUrl' || field.key === 'explorerUrl' ? 2048 : 64}
                    aria-invalid={!!errors[field.key]}
                    className="h-10"
                  />
                  {errors[field.key] && (
                    <span role="alert" className="block text-xs text-danger">
                      {errors[field.key]}
                    </span>
                  )}
                </label>
              ))}
          </div>
        ) : detail ? (
          <>
            <div className="flex min-w-0 items-center gap-3 py-1">
              <ChainIcon
                chain={detail.iconChain}
                className="size-11 shrink-0 rounded-full"
                showTooltip={false}
                alt=""
                aria-hidden="true"
              />
              <h2 className="min-w-0 break-words text-lg font-medium">{detail.label}</h2>
            </div>
            <dl className="space-y-3 rounded-xl bg-card p-4 text-sm">
              {detail.numericChainId !== undefined && (
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted">Chain ID</dt>
                  <dd className="font-mono text-xs">{detail.numericChainId}</dd>
                </div>
              )}
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Currency</dt>
                <dd className="break-all text-right">{detail.currencySymbol}</dd>
              </div>
            </dl>
            {ready && (
              <div key={detail.chainId} className="space-y-3">
                <RpcEndpoint chainId={detail.chainId} />
                <PreferredExplorer chainId={detail.chainId} />
              </div>
            )}
          </>
        ) : (
          <>
            {(['builtin', 'custom'] as const).map(source => {
              const group = options.filter(option => option.source === source)
              if (!group.length) return null
              return (
                <section
                  key={source}
                  className="space-y-2"
                  aria-label={source === 'custom' ? 'Custom networks' : 'Built-in networks'}
                >
                  {options.some(option => option.source === 'custom') && (
                    <h2 className="text-xs font-medium text-muted">
                      {source === 'custom' ? 'Custom' : 'Built in'}
                    </h2>
                  )}
                  {group.map(network => (
                    <button
                      key={network.chainId}
                      type="button"
                      aria-label={`Configure ${network.label} network`}
                      disabled={!ready || busy}
                      onClick={() => {
                        setError(null)
                        setDetailChainId(network.chainId)
                      }}
                      className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-3 text-left transition-colors hover:border-primary/30 disabled:cursor-not-allowed"
                    >
                      <ChainIcon
                        chain={network.iconChain}
                        className="size-7 shrink-0 rounded-full"
                        showTooltip={false}
                        alt=""
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium" title={network.label}>
                          {network.label}
                        </span>
                      </span>
                      <Icon icon="lucide:chevron-right" className="size-4 shrink-0 text-muted" />
                    </button>
                  ))}
                </section>
              )
            })}
          </>
        )}
      </div>
      {(editing !== undefined || (!detail && evmEnabled)) && (
        <div className="page-footer">
          {editing !== undefined ? (
            <Button
              className="h-11 w-full"
              isLoading={busy}
              disabled={!ready}
              onClick={() => void save()}
            >
              Save Network
            </Button>
          ) : (
            <Button
              className="h-11 w-full"
              disabled={!ready || busy}
              onClick={() => openEditor(null)}
            >
              <Icon icon="lucide:plus" className="mr-2 size-4" />
              Add Network
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => !open && !busy && setDeleteTarget(null)}
      >
        <DialogContent position="bottom">
          <DialogHeader>
            <DialogTitle>Remove {deleteTarget?.displayName}?</DialogTitle>
            <DialogDescription>
              {deleteTarget?.chainId === settings.activeEvmChainId
                ? 'Connected sites will be disconnected and the default EVM network will become active.'
                : 'This removes the network and disconnects its connected sites.'}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" isLoading={busy} onClick={() => void remove()}>
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
