import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { DatePicker } from '../../components/ui/date-picker'
import { ChainIcon } from '../../components/common/ChainIcon'
import { AccountNetworkList } from '../../components/account/AccountNetworkList'
import { useNavigate } from '../../provider/Router'
import { useDialog } from '../../hooks/useDialog'
import { switchWalletAccount } from '../../services/account-switch'
import { useWalletStore, rehydrateWalletStore } from '@/store/wallet-store'
import {
  availableSoftwareAccountFamilies,
  setAccountNetworkSelection
} from '../../services/account-network-selection-client'
import { getFullZcashRecoveryBirthdayHeight } from '@/core/wallet/birthday-height'
import { zcashWalletRuntimeClient } from '../../services/zcash-wallet-runtime-client'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { resolveEvmNetworkCatalog } from '@/core/chains/evm-runtime-config'
import { useSettingsStore } from '@/store/settings-store'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { LatestAttempt } from '@/lib/async-utils'
import { toast } from '@/store/toast-store'
import { formatSortAddress } from '@/lib/format'
import { accountNetworksClient } from '../../services/account-networks-client'
import {
  parseZcashHistoryRecoveryHeight,
  resolveZcashHistoryRecoveryDate
} from '../../services/import-zcash-history-selection'
import dayjs from '@/lib/dayjs'
import {
  isRetainedV1UpgradeAccount,
  type AccountNetworkFamily
} from '@/core/wallet/account-network-selection'
import {
  createBuildFeatureGatedChainRegistry,
  createInitialProductChainRegistry
} from '@/core/chains/registry'

type ZcashHistory = 'new' | 'date' | 'height'

export function ManageAccountNetworksPage() {
  const { goBack, navigate } = useNavigate()
  const { confirm } = useDialog()
  const [params] = useSearchParams()
  const walletId = params.get('walletId')
  const accountId = params.get('accountId')
  const wallet = useWalletStore(state => state.wallets.find(item => item.id === walletId))
  const currentWalletId = useWalletStore(state => state.currentWalletId)
  const currentAccountId = useWalletStore(state => state.currentAccountId)
  const currentNetwork = useWalletStore(state => state.currentNetwork)
  const chainEndpointSettings = useSettingsStore(state => state.chainEndpointSettings)
  const loadSettings = useSettingsStore(state => state.loadSettings)
  const account = wallet?.accounts.find(item => item.id === accountId)
  const guideMode =
    params.get('guide') === 'v1' && isRetainedV1UpgradeAccount(wallet, account, currentNetwork)
  const available = useMemo(() => availableSoftwareAccountFamilies(), [])
  const chains = useMemo(
    () =>
      createBuildFeatureGatedChainRegistry(
        createInitialProductChainRegistry(
          DEFAULT_NETWORK,
          resolveEvmNetworkCatalog(DEFAULT_NETWORK, chainEndpointSettings).filter(
            network => network.source === 'custom'
          )
        )
      )
        .list()
        .filter(chain => available.includes(chain.family)),
    [available, chainEndpointSettings]
  )
  const initial = useMemo(
    () =>
      account?.networkChainSelections?.[DEFAULT_NETWORK] ??
      chains
        .filter(chain =>
          (account?.networkSelections?.[DEFAULT_NETWORK] ?? available).includes(chain.family)
        )
        .map(chain => chain.id),
    [account, chains, available]
  )
  const [selected, setSelected] = useState<readonly string[]>(initial)
  const [successNotice, setSuccessNotice] = useState<{
    title: string
    chainName: string
    chainId: string | null
    address: string | null
  } | null>(null)
  const [history, setHistory] = useState<ZcashHistory>('new')
  const [date, setDate] = useState<dayjs.Dayjs | null>(null)
  const [height, setHeight] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attempts = useRef(new LatestAttempt())
  const savingRef = useRef(false)
  const initializedScope = useRef<string | null>(null)

  useEffect(() => {
    void loadSettings().catch(() => {})
  }, [loadSettings])

  useEffect(() => {
    const pending = attempts.current
    return () => pending.invalidate()
  }, [])

  useEffect(() => {
    if (!successNotice) return
    const timeout = setTimeout(() => setSuccessNotice(null), 4000)
    return () => clearTimeout(timeout)
  }, [successNotice])

  useEffect(() => {
    if (!account) {
      initializedScope.current = null
      return
    }
    const scope = `${currentNetwork}:${walletId}:${accountId}`
    if (initializedScope.current === scope) return
    initializedScope.current = scope
    setSelected(initial)
    setSuccessNotice(null)
    setHistory('new')
    setDate(null)
    setHeight('')
    setError(null)
    attempts.current.invalidate()
    savingRef.current = false
    setSaving(false)
  }, [walletId, accountId, currentNetwork, account, initial])

  if (
    !walletId ||
    !accountId ||
    !account ||
    (wallet?.keySource !== undefined && wallet.keySource !== 'software')
  ) {
    return (
      <div className="page-container">
        <PageHeader title="Networks" showBack />
        <div className="page-content flex items-center justify-center text-sm text-muted">
          Account unavailable
        </div>
      </div>
    )
  }

  const selectedFamilies: readonly AccountNetworkFamily[] = available.filter(family =>
    chains.some(chain => chain.family === family && selected.includes(chain.id))
  )
  const enablingZcash =
    selectedFamilies.includes('zcash') &&
    account.networkSelections?.[DEFAULT_NETWORK]?.includes('zcash') === false
  const choosingZcashHistory =
    enablingZcash &&
    !((account.networkBirthdayHeights?.[DEFAULT_NETWORK] ?? 0) > 0) &&
    !account.networkZcashHistoryConfigured?.[DEFAULT_NETWORK]
  const recoveryFloor = getFullZcashRecoveryBirthdayHeight(DEFAULT_NETWORK)
  const changed = chains.some(chain => selected.includes(chain.id) !== initial.includes(chain.id))

  const save = async (nextSelected: readonly string[] = selected, returnAfterSave = true) => {
    if (savingRef.current) return
    if (
      nextSelected.length === 0 ||
      !chains.some(chain => nextSelected.includes(chain.id) !== initial.includes(chain.id))
    )
      return
    savingRef.current = true
    const attempt = attempts.current.begin()
    const startingWalletId = currentWalletId
    const startingAccountId = currentAccountId
    setSaving(true)
    setError(null)
    try {
      let birthdayHeight: number | undefined
      if (choosingZcashHistory && history === 'height') {
        const parsed = parseZcashHistoryRecoveryHeight(height, recoveryFloor)
        if (parsed.error) {
          throw new Error(`Enter a block height of ${recoveryFloor.toLocaleString()} or later.`)
        }
        birthdayHeight = parsed.height
      } else if (choosingZcashHistory && history === 'date') {
        if (!date) throw new Error('Select the approximate date of the first ZEC transaction.')
        birthdayHeight = await resolveZcashHistoryRecoveryDate(date, recoveryFloor, timestamp =>
          zcashWalletRuntimeClient.getBlockByTime(timestamp)
        )
      }
      if (!attempts.current.isCurrent(attempt)) return
      const current = useWalletStore.getState()
      if (
        current.currentWalletId !== startingWalletId ||
        current.currentAccountId !== startingAccountId
      ) {
        throw new Error('Active account changed. Review networks and try again.')
      }
      if (current.currentWalletId !== walletId || current.currentAccountId !== accountId) {
        const switched = await switchWalletAccount({
          walletId,
          accountId,
          currentWalletId: current.currentWalletId,
          currentAccountId: current.currentAccountId,
          confirm
        })
        if (!switched || !attempts.current.isCurrent(attempt)) return
      }
      await setAccountNetworkSelection({
        walletId,
        accountId,
        families: available.filter(family =>
          chains.some(chain => chain.family === family && nextSelected.includes(chain.id))
        ),
        chainIds: nextSelected,
        ...(birthdayHeight === undefined ? {} : { birthdayHeight })
      })
      await rehydrateWalletStore()
      if (!attempts.current.isCurrent(attempt)) return
      if (attempts.current.isCurrent(attempt)) {
        setSelected(nextSelected)
        if (returnAfterSave) {
          toast.success('Networks updated')
          goBack()
        } else {
          const added = chains.filter(
            chain => nextSelected.includes(chain.id) && !initial.includes(chain.id)
          )
          const single = added.length === 1 ? added[0] : null
          const catalog = await accountNetworksClient.getCatalog().catch(() => null)
          if (!attempts.current.isCurrent(attempt)) return
          const address = single
            ? (catalog?.accounts
                .find(item => item.walletId === walletId && item.accountId === accountId)
                ?.networks.find(network => network.chain.id === single.id)
                ?.addresses.find(candidate => candidate.preferredForReceive)?.value ?? null)
            : null
          setSuccessNotice({
            title:
              added.length === 1 ? 'New network & address added' : 'Networks & addresses added',
            chainName: single?.displayName ?? `${added.length} networks`,
            chainId: single?.id ?? null,
            address
          })
        }
      }
    } catch (cause) {
      if (attempts.current.isCurrent(attempt))
        setError(cause instanceof Error ? cause.message : 'Could not update account networks')
    } finally {
      if (attempts.current.isCurrent(attempt)) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }

  const successChain = chains.find(chain => chain.id === successNotice?.chainId)
  const zcashAddress =
    account.networkAddresses?.[DEFAULT_NETWORK]?.transparent ?? account.addresses.transparent
  const leave = () => (guideMode ? navigate('/', { replace: true }) : goBack())
  const selectNetworks = (nextSelected: readonly string[]) => {
    if (guideMode) {
      void save(nextSelected, false)
    } else {
      setSelected(nextSelected)
      setError(null)
    }
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Add Networks"
        showBack
        onBack={leave}
        backDisabled={!guideMode && saving}
      />
      <div className="page-content min-w-0 px-4 pb-4 pt-0">
        <AccountNetworkList
          chains={chains}
          selected={selected}
          disabled={saving}
          onAdd={chainId => selectNetworks([...selected, chainId])}
          onAddAll={() => selectNetworks(chains.map(chain => chain.id))}
          onRemove={
            guideMode ? undefined : chainId => selectNetworks(selected.filter(id => id !== chainId))
          }
          zcashAddress={zcashAddress ? formatSortAddress(zcashAddress) : undefined}
        />
        {choosingZcashHistory && (
          <div className="mt-5 border-t border-border pt-4">
            <h2 className="text-sm font-medium">Zcash history</h2>
            <div
              role="radiogroup"
              aria-label="Zcash history"
              className="mt-3 grid grid-cols-3 gap-2"
            >
              {(
                [
                  ['new', 'New'],
                  ['date', 'Date'],
                  ['height', 'Block height']
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={history === value}
                  disabled={saving}
                  onClick={() => setHistory(value)}
                  className={`min-h-10 rounded-md border px-2 text-xs ${history === value ? 'border-primary text-foreground' : 'border-border text-muted'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {history === 'date' && (
              <div className="mt-4">
                <label className="mb-2 block text-sm text-muted">First ZEC transaction</label>
                <DatePicker
                  value={date}
                  onChange={setDate}
                  minDate={dayjs(DEFAULT_NETWORK === 'mainnet' ? '2018-10-01' : '2018-01-01')}
                  ariaLabel="First ZEC transaction date"
                />
              </div>
            )}
            {history === 'height' && (
              <div className="mt-4">
                <label className="mb-2 block text-sm text-muted">Zcash block height</label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={height}
                  onChange={event => setHeight(event.target.value)}
                  placeholder={`At least ${recoveryFloor.toLocaleString()}`}
                  aria-label="Zcash birthday height"
                />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="page-footer space-y-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <p className="flex items-start gap-2 text-sm leading-5 text-muted">
          <Icon icon="lucide:info" width={15} height={15} className="mt-0.5 shrink-0" />
          <span>
            Adding a network creates an address from your existing recovery phrase. No funds move.
          </span>
        </p>
        <Button
          className="h-[45px] w-full"
          disabled={!guideMode && (selected.length === 0 || saving)}
          isLoading={!guideMode && saving}
          onClick={() => {
            if (!guideMode && changed) void save()
            else leave()
          }}
        >
          {!guideMode && changed && (currentWalletId !== walletId || currentAccountId !== accountId)
            ? 'Switch account and continue'
            : 'Continue'}
        </Button>
      </div>
      {successNotice && (
        <div
          role="status"
          className="absolute inset-x-4 top-4 z-50 rounded-lg border border-white/10 bg-[#2b2b36] px-3 py-3 shadow-lg"
        >
          <div className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#20642c] text-[#00d18a]">
              <Icon icon="lucide:check" width={16} height={16} />
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium">{successNotice.title}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setSuccessNotice(null)}
              className="flex size-6 shrink-0 items-center justify-center text-muted hover:text-white"
            >
              <Icon icon="lucide:x" width={18} height={18} />
            </button>
          </div>
          <div className="ml-8 mt-1 flex min-w-0 items-center gap-2 text-sm">
            {successNotice.chainId && (
              <ChainIcon
                chain={
                  successChain
                    ? resolveChainIconAlias(
                        successChain.family,
                        successChain.displayName,
                        successChain.id
                      )
                    : 'evm'
                }
                showTooltip={false}
                className="size-4 shrink-0 rounded"
              />
            )}
            <span className="shrink-0">{successNotice.chainName}</span>
            {successNotice.address && (
              <span className="min-w-0 truncate text-muted">
                {formatSortAddress(successNotice.address)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
