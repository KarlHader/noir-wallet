import { Icon } from '@iconify/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ZERO_INDEXER_NODES_STORAGE_KEY,
  ZERO_INDEXER_RUNTIME_STORAGE_KEY
} from '@/infrastructure/chains/zero-indexer-preferences'
import type { ZeroIndexerEndpoint, ZeroIndexerNodeStatus } from '@/core/zcash/zero-indexer'
import { SETTINGS_STORAGE_KEY } from '@/lib/wallet-settings-storage'
import { cn } from '@/lib/utils'
import {
  EndpointLatencyBadge,
  EndpointSelectionIndicator
} from '../../components/common/EndpointStatus'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { ListSkeleton } from '../../components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { sendZeroIndexerNodeMessage } from '../../services/zero-indexer-node-client'
import {
  validateZeroIndexerNodeUrl,
  zeroIndexerNodeErrorField
} from '../../services/zero-indexer-node-model'

export function ZeroIndexerNodes() {
  const [status, setStatus] = useState<ZeroIndexerNodeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [applyingKey, setApplyingKey] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ZeroIndexerEndpoint | null>(null)
  const revision = useRef(0)
  const mounted = useRef(false)

  const loadStatus = useCallback(async (refresh = false) => {
    const currentRevision = ++revision.current
    if (refresh) setRefreshing(true)
    try {
      const next = await sendZeroIndexerNodeMessage({
        type: 'GET_ZERO_INDEXER_NODE_STATUS',
        refresh
      })
      if (mounted.current && currentRevision === revision.current) {
        setStatus(next.status)
        setError(next.warning ?? null)
      }
    } catch (cause) {
      if (mounted.current && currentRevision === revision.current) {
        setError(cause instanceof Error ? cause.message : 'Could not load broadcast nodes')
      }
    } finally {
      if (mounted.current && currentRevision === revision.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let active = true
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (
        (area === 'local' &&
          (changes[ZERO_INDEXER_NODES_STORAGE_KEY] ||
            changes[ZERO_INDEXER_RUNTIME_STORAGE_KEY] ||
            changes[SETTINGS_STORAGE_KEY])) ||
        (area === 'session' && changes[ZERO_INDEXER_RUNTIME_STORAGE_KEY])
      )
        void loadStatus()
    }
    chrome.storage.onChanged.addListener(onChanged)
    void loadStatus().then(() => {
      if (active) void loadStatus(true)
    })
    return () => {
      active = false
      mounted.current = false
      revision.current += 1
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [loadStatus])

  const mutate = async (
    key: string,
    message:
      | { type: 'SELECT_ZERO_INDEXER_NODE'; endpointId: string | null }
      | { type: 'ADD_CUSTOM_ZERO_INDEXER_NODE'; label: string; url: string }
      | { type: 'REMOVE_CUSTOM_ZERO_INDEXER_NODE'; endpointId: string }
  ): Promise<{ saved: boolean; error?: string }> => {
    if (applyingKey) return { saved: false }
    ++revision.current
    setApplyingKey(key)
    setError(null)
    try {
      const next = await sendZeroIndexerNodeMessage(message)
      if (mounted.current) {
        ++revision.current
        setStatus(next.status)
        setError(next.warning ?? null)
      }
      return { saved: true }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not update broadcast node'
      if (mounted.current && key !== 'add') setError(message)
      return { saved: false, error: message }
    } finally {
      if (mounted.current) {
        setApplyingKey(null)
        setRefreshing(false)
      }
    }
  }

  const addNode = async () => {
    const validationError = validateZeroIndexerNodeUrl(url)
    if (validationError) {
      setUrlError(validationError)
      return
    }
    setNameError(null)
    setUrlError(null)
    setAddError(null)
    const result = await mutate('add', {
      type: 'ADD_CUSTOM_ZERO_INDEXER_NODE',
      label: name.trim(),
      url: url.trim()
    })
    if (result.saved) {
      setAddOpen(false)
      setName('')
      setUrl('')
    } else if (result.error) {
      const field = zeroIndexerNodeErrorField(result.error)
      if (field === 'name') setNameError(result.error)
      else if (field === 'url') setUrlError(result.error)
      else setAddError(result.error)
    }
  }

  const removeNode = async () => {
    if (!deleteTarget) return
    const result = await mutate('remove', {
      type: 'REMOVE_CUSTOM_ZERO_INDEXER_NODE',
      endpointId: deleteTarget.id
    })
    if (result.saved) setDeleteTarget(null)
  }

  const endpoints = status ? [...status.managedEndpoints, ...status.customEndpoints] : []
  const preferred = endpoints.find(endpoint => endpoint.id === status?.orderedEndpointIds[0])

  const renderNode = (endpoint: ZeroIndexerEndpoint, custom: boolean, index: number) => {
    const selected = status?.mode === 'fixed' && status.selectedEndpointId === endpoint.id
    return (
      <div
        key={endpoint.id}
        className={cn('flex min-h-11 items-center', index > 0 && 'border-t border-white/10')}
      >
        <button
          type="button"
          aria-pressed={selected}
          disabled={applyingKey !== null}
          onClick={() =>
            void mutate(endpoint.id, { type: 'SELECT_ZERO_INDEXER_NODE', endpointId: endpoint.id })
          }
          className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 disabled:opacity-50"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm">
              <span className="truncate">{endpoint.label}</span>
              {custom && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  Custom
                </span>
              )}
            </span>
            <span className="block truncate font-mono text-[11px] text-muted">
              {endpoint.url.replace(/^https:\/\//, '')}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <EndpointLatencyBadge result={status?.probes[endpoint.id]} />
            <EndpointSelectionIndicator
              selected={!!selected}
              applying={applyingKey === endpoint.id}
            />
          </span>
        </button>
        {custom && (
          <button
            type="button"
            title={`Remove ${endpoint.label}`}
            aria-label={`Remove ${endpoint.label}`}
            disabled={applyingKey !== null}
            onClick={() => setDeleteTarget(endpoint)}
            className="mr-2 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:text-danger disabled:opacity-50"
          >
            <Icon icon="lucide:trash-2" className="size-4" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Broadcast Nodes"
        showBack
        action={{
          ariaLabel: 'Refresh broadcast nodes',
          icon: (
            <Icon icon="lucide:refresh-cw" className={cn('size-4', refreshing && 'animate-spin')} />
          ),
          onClick: () => {
            if (!refreshing) void loadStatus(true)
          }
        }}
      />
      <div className="page-content space-y-5 pb-5">
        {error && status && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {!status ? (
          error ? (
            <InlineError message={error} onRetry={() => void loadStatus()} retrying={refreshing} />
          ) : (
            <ListSkeleton rows={4} label="Loading broadcast nodes" card />
          )
        ) : (
          <>
            <section className="space-y-2">
              <h2 className="px-1 text-xs text-muted">
                {status.network === 'testnet' ? 'Zcash Testnet' : 'Zcash Mainnet'}
              </h2>
              <div className="overflow-hidden rounded-lg border border-white/10 bg-card">
                <button
                  type="button"
                  aria-pressed={status.mode === 'auto'}
                  disabled={applyingKey !== null}
                  onClick={() =>
                    void mutate('auto', { type: 'SELECT_ZERO_INDEXER_NODE', endpointId: null })
                  }
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/5 disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm">
                      <span>Auto</span>
                      {status.mode === 'auto' && preferred && (
                        <span className="truncate text-xs text-muted">{preferred.label}</span>
                      )}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {status.mode === 'auto' && (
                      <EndpointLatencyBadge
                        result={preferred ? status.probes[preferred.id] : undefined}
                      />
                    )}
                    <EndpointSelectionIndicator
                      selected={status.mode === 'auto'}
                      applying={applyingKey === 'auto'}
                    />
                  </span>
                </button>
                {status.managedEndpoints.map((endpoint, index) =>
                  renderNode(endpoint, false, index + 1)
                )}
              </div>
            </section>
            <section className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xs text-muted">Custom Nodes</h2>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={applyingKey !== null}
                  onClick={() => setAddOpen(true)}
                >
                  <Icon icon="lucide:plus" className="size-4" /> Add
                </Button>
              </div>
              {status.customEndpoints.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-white/10 bg-card">
                  {status.customEndpoints.map((endpoint, index) =>
                    renderNode(endpoint, true, index)
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={open => !applyingKey && setAddOpen(open)}>
        <DialogContent position="bottom">
          <DialogHeader>
            <DialogTitle>Add Broadcast Node</DialogTitle>
            <DialogDescription className="sr-only">Add a private broadcast node</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Input
                aria-label="Node name"
                aria-invalid={!!nameError}
                value={name}
                maxLength={64}
                onChange={event => {
                  setName(event.target.value)
                  setNameError(null)
                }}
                placeholder="Name (optional)"
                className="h-11 rounded-lg"
              />
              {nameError && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {nameError}
                </p>
              )}
            </div>
            <div>
              <Input
                aria-label="Node URL"
                aria-invalid={!!urlError}
                type="url"
                value={url}
                onChange={event => {
                  setUrl(event.target.value)
                  setUrlError(null)
                }}
                placeholder="https://example.com"
                className="h-11 rounded-lg font-mono text-xs"
              />
              {urlError && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {urlError}
                </p>
              )}
            </div>
          </div>
          {addError && (
            <p role="alert" className="text-xs text-danger">
              {addError}
            </p>
          )}
          <Button
            className="h-11 w-full"
            isLoading={applyingKey === 'add'}
            disabled={applyingKey !== null || !url.trim()}
            onClick={() => void addNode()}
          >
            Verify & Add
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => !open && !applyingKey && setDeleteTarget(null)}
      >
        <DialogContent position="bottom">
          <DialogHeader>
            <DialogTitle>Remove {deleteTarget?.label}?</DialogTitle>
            <DialogDescription>
              {status?.mode === 'fixed' && status.selectedEndpointId === deleteTarget?.id
                ? 'Auto will be selected.'
                : 'Remove this saved node?'}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="h-11 flex-1"
              disabled={!!applyingKey}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11 flex-1"
              isLoading={applyingKey === 'remove'}
              disabled={applyingKey !== null}
              onClick={() => void removeNode()}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
