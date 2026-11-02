import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import {
  type ChainEndpointSettings,
  type CustomChainExplorer
} from '@/core/chains/chain-endpoint-settings'
import { useSettingsStore } from '@/store/settings-store'
import { toast } from '@/store/toast-store'
import { EndpointOption } from '../../components/common/EndpointOption'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { chainEndpointSettingsClient } from '../../services/chain-endpoint-settings-client'
import {
  buildExplorerChainOptions,
  type ExplorerChainOption
} from '@/popup/services/chain-settings-options'
import {
  buildCustomExplorer,
  buildExplorerSelectionSettings,
  getExplorerSelection,
  isDefaultExplorer,
  isSameExplorer
} from '@/popup/services/explorer-settings-model'

export function PreferredExplorer({ chainId }: { readonly chainId: string }) {
  const persistedSettings = useSettingsStore(state => state.chainEndpointSettings)
  const isLoaded = useSettingsStore(state => state.isLoaded)
  const setSettings = useSettingsStore(state => state.setChainEndpointSettings)
  const loadSettings = useSettingsStore(state => state.loadSettings)
  const [currentSettings, setCurrentSettings] = useState<ChainEndpointSettings | null>(null)
  const settings = currentSettings ?? persistedSettings
  const [editing, setEditing] = useState<ExplorerChainOption | null>(null)
  const [customEditing, setCustomEditing] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [transactionPath, setTransactionPath] = useState('tx')
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const operation = useRef(0)
  const busy = useRef(false)
  const options = useMemo(() => buildExplorerChainOptions(settings), [settings])
  const option = options.find(item => item.chainId === chainId)
  const effective = option && getExplorerSelection(settings, option)
  const effectiveExplorer = option
    ? (effective?.selected ?? effective?.presets.find(preset => isDefaultExplorer(option, preset)))
    : undefined
  const { presets, selected, custom } = editing
    ? getExplorerSelection(settings, editing)
    : { presets: [], selected: undefined, custom: undefined }

  useEffect(() => {
    loadSettings().catch(() => {})
    return () => {
      operation.current += 1
    }
  }, [loadSettings])

  useEffect(() => {
    operation.current += 1
    busy.current = false
    setCurrentSettings(null)
    setEditing(null)
    setCustomEditing(false)
    setOpening(false)
    setSaving(false)
  }, [chainId])

  const openEditor = async () => {
    if (busy.current) return
    busy.current = true
    const request = ++operation.current
    setOpening(true)
    try {
      const current = await chainEndpointSettingsClient.read()
      if (request !== operation.current) return
      setCurrentSettings(current)
      const refreshed = buildExplorerChainOptions(current).find(item => item.chainId === chainId)
      if (refreshed) {
        setEditing(refreshed)
        setCustomEditing(false)
      }
    } catch (error) {
      if (request === operation.current) {
        toast.error(
          'Explorer Settings Unavailable',
          error instanceof Error ? error.message : 'Please try again.'
        )
      }
    } finally {
      if (request === operation.current) {
        setOpening(false)
        busy.current = false
      }
    }
  }

  const openCustomEditor = () => {
    if (!editing) return
    setName(custom?.label ?? '')
    setUrl(custom?.baseUrl ?? '')
    setTransactionPath(custom?.transactionPath ?? editing.defaultTransactionPath)
    setCustomEditing(true)
  }

  const apply = async (explorer: CustomChainExplorer) => {
    if (!editing || busy.current) return
    busy.current = true
    const request = ++operation.current
    setSaving(true)
    try {
      const current = await chainEndpointSettingsClient.read()
      if (request !== operation.current) return
      const next = buildExplorerSelectionSettings(current, editing, explorer)
      const saved = await chainEndpointSettingsClient.apply(next, current)
      if (request !== operation.current) return
      setCurrentSettings(saved)
      setSettings(saved)
      toast.success('Explorer updated')
      setEditing(null)
    } catch (error) {
      if (request === operation.current) {
        toast.error(
          'Explorer Update Failed',
          error instanceof Error ? error.message : 'Check the explorer URL and path.'
        )
      }
    } finally {
      if (request === operation.current) {
        setSaving(false)
        busy.current = false
      }
    }
  }

  return (
    <>
      {option && (
        <button
          type="button"
          aria-label="Block Explorer"
          disabled={!isLoaded || opening || saving}
          onClick={() => void openEditor()}
          className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-3 text-left transition-colors hover:border-primary/30 disabled:opacity-50"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Block Explorer</span>
            <span className="block truncate text-xs text-muted">
              {!isLoaded ? 'Loading...' : (effectiveExplorer?.label ?? 'Not configured')}
              {isLoaded &&
                effectiveExplorer?.baseUrl &&
                ` · ${effectiveExplorer.baseUrl.replace(/^https?:\/\//, '')}`}
            </span>
          </span>
          <Icon icon="lucide:chevron-right" className="size-4 shrink-0 text-muted" />
        </button>
      )}

      <Dialog open={editing !== null} onOpenChange={open => !open && !saving && setEditing(null)}>
        <DialogContent
          position="bottom"
          className="flex max-h-[92vh] flex-col gap-3 p-5"
          aria-describedby={undefined}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {customEditing ? 'Custom Explorer' : `${editing?.label} Explorer`}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto">
            {customEditing ? (
              <div className="space-y-3">
                <Input
                  aria-label="Custom explorer name"
                  value={name}
                  maxLength={64}
                  disabled={saving}
                  onChange={event => setName(event.target.value)}
                  placeholder="Name (optional)"
                  className="h-11 rounded-lg"
                />
                <Input
                  aria-label={`${editing?.label ?? ''} explorer URL`}
                  type="url"
                  value={url}
                  disabled={saving}
                  onChange={event => setUrl(event.target.value)}
                  placeholder="https://explorer.example"
                  className="h-11 rounded-lg font-mono text-xs"
                />
                <label className="block space-y-1.5 text-xs text-muted">
                  <span>Transaction path</span>
                  <Input
                    aria-label="Transaction path"
                    value={transactionPath}
                    disabled={saving}
                    onChange={event => setTransactionPath(event.target.value)}
                    placeholder="tx"
                    className="h-11 rounded-lg font-mono text-xs"
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="space-y-2" aria-label="Explorer presets">
                  {presets.map(preset => (
                    <EndpointOption
                      key={`${preset.baseUrl}/${preset.transactionPath}`}
                      label={preset.label}
                      url={preset.baseUrl}
                      ariaLabel={`Use ${preset.label} explorer`}
                      selected={
                        selected
                          ? isSameExplorer(selected, preset)
                          : isDefaultExplorer(editing!, preset)
                      }
                      disabled={saving}
                      onClick={() => void apply(preset)}
                    />
                  ))}
                </div>
                <section className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">Custom Explorer</h3>
                    <Button
                      variant="outline"
                      className="h-8 gap-1.5 px-2.5 text-xs"
                      disabled={saving}
                      onClick={openCustomEditor}
                    >
                      <Icon icon={custom ? 'lucide:pencil' : 'lucide:plus'} className="size-3.5" />
                      {custom ? 'Edit' : 'Add'}
                    </Button>
                  </div>
                  {custom && (
                    <EndpointOption
                      label={custom.label}
                      url={custom.baseUrl}
                      selected
                      ariaLabel={`Use ${custom.label} explorer`}
                      disabled={saving}
                      onClick={() => void apply(custom)}
                    />
                  )}
                </section>
              </>
            )}
          </div>
          {customEditing && (
            <div className="grid shrink-0 grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-11"
                disabled={saving}
                onClick={() => setCustomEditing(false)}
              >
                Cancel
              </Button>
              <Button
                className="h-11"
                isLoading={saving}
                disabled={!url.trim() || !transactionPath.trim()}
                onClick={() =>
                  editing && void apply(buildCustomExplorer(editing, name, url, transactionPath))
                }
              >
                Save Explorer
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
