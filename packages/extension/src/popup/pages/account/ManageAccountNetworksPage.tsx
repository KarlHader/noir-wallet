import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { DatePicker } from '../../components/ui/date-picker'
import { AccountNetworkFamilyChoices } from '../../components/account/AccountNetworkFamilyChoices'
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
import { LatestAttempt } from '@/lib/async-utils'
import { toast } from '@/store/toast-store'
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
  const available = useMemo<readonly AccountNetworkFamily[]>(
    () =>
      availableSoftwareAccountFamilies().filter(family => family === 'zcash' || family === 'evm'),
    []
  )
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
      available.filter(
        family => account?.networkSelections?.[DEFAULT_NETWORK]?.includes(family) ?? true
      ),
    [account, available]
  )
  const [selected, setSelected] = useState<readonly AccountNetworkFamily[]>(initial)
  const [history, setHistory] = useState<ZcashHistory>('new')
  const [date, setDate] = useState<dayjs.Dayjs | null>(null)
  const [height, setHeight] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addressPreviews, setAddressPreviews] = useState<
    Partial<Record<AccountNetworkFamily, string>>
  >({})
  const [addressesLoading, setAddressesLoading] = useState(false)
  const [addressRefresh, setAddressRefresh] = useState(0)
  const [addressPreviewScope, setAddressPreviewScope] = useState<string | null>(null)
  const previewScope = `${currentNetwork}:${walletId}:${accountId}:${addressRefresh}`
  const attempts = useRef(new LatestAttempt())
  const savingRef = useRef(false)
  const initializedScope = useRef<string | null>(null)

  useEffect(() => {
    void loadSettings().catch(() => {})
  }, [loadSettings])

  useEffect(() => {
    if (!walletId || !accountId) return
    let cancelled = false
    setAddressPreviewScope(null)
    setAddressPreviews({})
    setAddressesLoading(true)
    void accountNetworksClient
      .getCatalog()
      .then(catalog => {
        if (cancelled) return
        const networks = catalog?.accounts.find(
          item => item.walletId === walletId && item.accountId === accountId
        )?.networks
        const zcash = networks?.find(network => network.chain.family === 'zcash')
        const evm = networks?.find(network => network.chain.family === 'evm')
        const zcashAddress =
          zcash?.addresses.find(address => address.privacy === 'transparent')?.value ??
          zcash?.addresses.find(address => address.preferredForReceive)?.value
        const evmAddress = evm?.addresses.find(address => address.preferredForReceive)?.value
        setAddressPreviews({
          ...(zcashAddress ? { zcash: zcashAddress } : {}),
          ...(evmAddress ? { evm: evmAddress } : {})
        })
        setAddressPreviewScope(previewScope)
      })
      .catch(() => {
        if (!cancelled) {
          setAddressPreviews({})
          setAddressPreviewScope(previewScope)
        }
      })
      .finally(() => {
        if (!cancelled) setAddressesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [walletId, accountId, currentNetwork, addressRefresh, previewScope])

  useEffect(() => {
    const pending = attempts.current
    return () => pending.invalidate()
  }, [])

  useEffect(() => {
    if (!account) {
      initializedScope.current = null
      return
    }
    const scope = `${currentNetwork}:${walletId}:${accountId}`
    if (initializedScope.current === scope) return
    initializedScope.current = scope
    setSelected(initial)
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

  const enablingZcash =
    selected.includes('zcash') &&
    account.networkSelections?.[DEFAULT_NETWORK]?.includes('zcash') === false
  const choosingZcashHistory =
    enablingZcash &&
    !((account.networkBirthdayHeights?.[DEFAULT_NETWORK] ?? 0) > 0) &&
    !account.networkZcashHistoryConfigured?.[DEFAULT_NETWORK]
  const recoveryFloor = getFullZcashRecoveryBirthdayHeight(DEFAULT_NETWORK)
  const changed = available.some(family => selected.includes(family) !== initial.includes(family))

  const save = async () => {
    if (savingRef.current) return
    if (selected.length === 0 || !changed) return
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
        families: selected,
        chainIds: chains.filter(chain => selected.includes(chain.family)).map(chain => chain.id),
        ...(birthdayHeight === undefined ? {} : { birthdayHeight })
      })
      await rehydrateWalletStore()
      if (!attempts.current.isCurrent(attempt)) return
      if (guideMode) setAddressRefresh(value => value + 1)
      toast.success('Networks updated')
      if (!guideMode) goBack()
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

  const leave = () => (guideMode ? navigate('/', { replace: true }) : goBack())

  return (
    <div className="page-container">
      <PageHeader title="Add Networks" showBack onBack={leave} backDisabled={saving} />
      <div className="page-content min-w-0 px-4 pb-4 pt-0">
        <AccountNetworkFamilyChoices
          availableFamilies={available}
          selectedFamilies={selected}
          initialSelectedFamilies={initial}
          variant="management"
          disabled={saving}
          requireSelection
          addressPreviews={addressPreviewScope === previewScope ? addressPreviews : {}}
          addressesLoading={addressPreviewScope !== previewScope || addressesLoading}
          hideMissingAddressPreviews
          onChange={families => {
            setSelected(families)
            setError(null)
          }}
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
        <Button
          className="h-[45px] w-full"
          disabled={saving || (changed && selected.length === 0) || (!guideMode && !changed)}
          isLoading={saving}
          onClick={() => {
            if (changed) void save()
            else leave()
          }}
        >
          {changed || !guideMode
            ? currentWalletId !== walletId || currentAccountId !== accountId
              ? 'Switch account and save'
              : 'Save'
            : 'Done'}
        </Button>
      </div>
    </div>
  )
}
