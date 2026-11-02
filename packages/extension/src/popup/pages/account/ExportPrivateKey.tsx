import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { getResponseErrorMessage } from '@/lib/errors'
import { PageHeader } from '../../components/common/PageHeader'
import { InlineError } from '../../components/common/InlineError'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { WarningBox } from '../../components/ui/WarningBox'
import { CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import { ChainIcon } from '../../components/common/ChainIcon'
import { accountNetworkIconChain } from '@/popup/services/account-network-presentation'
import {
  groupAccountNetworksForDisplay,
  type AccountNetworkDisplayGroup
} from '../../components/account/account-network-groups'
import {
  accountNetworksClient,
  type AccountNetworkView
} from '../../services/account-networks-client'
import {
  getPrivateKeyExportErrorMessage,
  isValidPrivateKeyExport,
  type PrivateKeyExportFormat
} from '@/popup/services/private-key-export'

type BitcoinAddressType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'

const BITCOIN_TYPES = Object.freeze([
  ['p2wpkh', 'Native SegWit'],
  ['p2pkh', 'Legacy'],
  ['p2sh-p2wpkh', 'Nested SegWit'],
  ['p2tr', 'Taproot']
] as const)

function ExportNetworkIcon({ group }: { readonly group: AccountNetworkDisplayGroup }) {
  if (group.family === 'evm') {
    return (
      <span
        data-slot="chain-icon-group"
        aria-hidden="true"
        className="flex h-8 shrink-0 items-center -space-x-1"
      >
        {group.networks.slice(0, 4).map(network => (
          <ChainIcon
            key={network.chain.id}
            chain={accountNetworkIconChain(network)}
            width={16}
            height={16}
            className="rounded-[4px] ring-1 ring-card"
            showTooltip={false}
          />
        ))}
      </span>
    )
  }

  const network = group.networks[0]
  return (
    <span
      data-slot="chain-icon-group"
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white"
    >
      <ChainIcon
        chain={accountNetworkIconChain(network)}
        className="size-8 rounded-full"
        showTooltip={false}
      />
    </span>
  )
}

export function ExportPrivateKey() {
  const [searchParams] = useSearchParams()
  const walletId = searchParams.get('walletId') ?? ''
  const accountId = searchParams.get('accountId') ?? ''
  const [networks, setNetworks] = useState<readonly AccountNetworkView[]>([])
  const [chainId, setChainId] = useState('')
  const [bitcoinAddressType, setBitcoinAddressType] = useState<BitcoinAddressType>('p2wpkh')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [format, setFormat] = useState<PrivateKeyExportFormat | null>(null)
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(true)
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { copyToClipboard, showToast } = useCopyToClipboard()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setCatalogLoadFailed(false)
    setError(null)
    setNetworks([])
    void accountNetworksClient
      .getCatalog()
      .then(catalog => {
        if (cancelled) return
        const account = catalog?.accounts.find(
          item => item.walletId === walletId && item.accountId === accountId
        )
        const supported =
          account?.networks.filter(
            network =>
              network.chain.family === 'evm' ||
              network.chain.family === 'bitcoin' ||
              network.chain.family === 'solana' ||
              network.chain.family === 'near'
          ) ?? []
        setNetworks(supported)
        setChainId(current =>
          supported.some(network => network.chain.id === current)
            ? current
            : (supported[0]?.chain.id ?? '')
        )
      })
      .catch(reason => {
        if (!cancelled) {
          setCatalogLoadFailed(true)
          setError(reason instanceof Error ? reason.message : 'Account unavailable')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, walletId, loadAttempt])

  const networkGroups = useMemo(() => groupAccountNetworksForDisplay(networks), [networks])
  const selectedGroup = useMemo(
    () => networkGroups.find(group => group.networks.some(network => network.chain.id === chainId)),
    [chainId, networkGroups]
  )
  const selected = selectedGroup?.networks[0]
  const selectedLabel =
    selectedGroup?.family === 'evm' ? 'EVM' : selectedGroup?.networks[0]?.chain.displayName

  const exportKey = async () => {
    if (!selected) return
    setExporting(true)
    setError(null)
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'EXPORT_PRIVATE_KEY',
        walletId,
        accountId,
        chainId: selected.chain.id,
        password,
        ...(selected.chain.family === 'bitcoin' ? { bitcoinAddressType } : {})
      })
      if (
        typeof response !== 'object' ||
        response === null ||
        Array.isArray(response) ||
        (response as { success?: unknown }).success !== true
      ) {
        throw new Error(getResponseErrorMessage(response) ?? 'Private-key export failed')
      }
      const result = (response as { result?: unknown }).result
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error('Private-key export response is invalid')
      }
      const value = result as { privateKey?: unknown; format?: unknown }
      if (!isValidPrivateKeyExport(selected.chain.family, value)) {
        throw new Error('Private-key export response is invalid')
      }
      setPrivateKey(value.privateKey)
      setFormat(value.format)
      setPassword('')
      setVisible(false)
    } catch (reason) {
      setError(getPrivateKeyExportErrorMessage(reason))
    } finally {
      setExporting(false)
    }
  }

  if (privateKey) {
    return (
      <div className="page-container">
        <CopyToast show={showToast} />
        <PageHeader title="Private key" showBack />
        <div className="page-content space-y-5">
          <WarningBox>
            Never share this private key. Anyone with it can permanently move the assets for this
            account.
          </WarningBox>
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex min-w-0 items-center gap-2.5">
                {selectedGroup && <ExportNetworkIcon group={selectedGroup} />}
                <div className="min-w-0">
                  {selected && <p className="truncate text-sm font-medium">{selectedLabel}</p>}
                  <p className="text-xs uppercase tracking-wide text-muted">{format}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setVisible(value => !value)}
                className="flex items-center gap-1.5 text-xs text-muted"
              >
                <Icon icon={visible ? 'lucide:eye-off' : 'lucide:eye'} width={16} height={16} />
                {visible ? 'Hide' : 'Reveal'}
              </button>
            </div>
            <p
              className={`break-all font-mono text-sm leading-6 ${
                visible ? '' : 'select-none blur-[7px]'
              }`}
            >
              {privateKey}
            </p>
          </div>
        </div>
        <div className="page-footer">
          <Button className="h-[45px] w-full" onClick={() => copyToClipboard(privateKey)}>
            Copy private key
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      <PageHeader title="Export private key" showBack />
      <div className="page-content space-y-5">
        <div>
          <p className="mb-2 text-sm text-muted">Network</p>
          {loading ? (
            <div className="h-[46px] animate-pulse rounded-xl bg-card" />
          ) : (
            <div className="space-y-2">
              {networkGroups.map(group => {
                const network = group.networks[0]
                const isSelected = selectedGroup?.id === group.id
                const label = group.family === 'evm' ? 'EVM' : network.chain.displayName
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setChainId(network.chain.id)}
                    className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left ${
                      isSelected ? 'border-primary/70 bg-primary/10' : 'border-border bg-card'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <ExportNetworkIcon group={group} />
                      <span className="truncate">{label}</span>
                    </span>
                    <span
                      className={`h-4 w-4 rounded-full border ${
                        isSelected ? 'border-4 border-primary' : 'border-muted'
                      }`}
                    />
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {selected?.chain.family === 'bitcoin' && (
          <div>
            <p className="mb-2 text-sm text-muted">Address type</p>
            <div className="grid grid-cols-2 gap-2">
              {BITCOIN_TYPES.map(([type, label]) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setBitcoinAddressType(type)}
                  className={`rounded-xl border px-3 py-2.5 text-sm ${
                    bitcoinAddressType === type
                      ? 'border-primary/70 bg-primary/10'
                      : 'border-border bg-card'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label htmlFor="private-key-export-password" className="mb-2 block text-sm text-muted">
            Enter password
          </label>
          <Input
            id="private-key-export-password"
            type="password"
            value={password}
            onChange={event => {
              setPassword(event.target.value)
              setError(null)
            }}
            onKeyDown={event => event.key === 'Enter' && void exportKey()}
            className="h-[46px] rounded-xl"
            placeholder="Wallet password"
          />
        </div>
        {networks.length === 0 && !loading && !error && (
          <p className="text-sm text-muted">No exportable account is available.</p>
        )}
        {error && (
          <InlineError
            message={error}
            onRetry={
              catalogLoadFailed && !loading ? () => setLoadAttempt(value => value + 1) : undefined
            }
          />
        )}
      </div>
      <div className="page-footer">
        <Button
          className="h-[45px] w-full"
          disabled={!selected || !password || exporting}
          isLoading={exporting}
          onClick={exportKey}
        >
          Reveal private key
        </Button>
      </div>
    </div>
  )
}
