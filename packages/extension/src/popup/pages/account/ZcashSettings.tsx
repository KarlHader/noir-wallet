import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { AccountDomainBadge } from '../../components/account/AccountDomainBadge'
import { ShieldedAddressHistorySheet } from '../../components/account/ShieldedAddressHistorySheet'
import { ChainIcon } from '../../components/common/ChainIcon'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { accountNetworkIconChain } from '@/popup/services/account-network-presentation'
import {
  accountNetworksClient,
  type AccountNetworkAddressView,
  type AccountNetworkView
} from '../../services/account-networks-client'
import { useResyncZcash } from '../../hooks/useResyncZcash'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { classifyError } from '@/lib/errors'
import { formatSortAddress, getAccountDisplayName } from '@/lib/format'
import { getBirthdayDateFromBlockTimestamp } from '@/lib/zcash-birthday'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { useWalletStore } from '@/store/wallet-store'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getZcashDerivationPaths } from '@/lib/zcash-derivation'
import { DedupPromise } from '@/lib/async-utils'

function privacyLabel(address: AccountNetworkAddressView): 'Shielded' | 'Transparent' {
  return address.privacy === 'transparent' ? 'Transparent' : 'Shielded'
}

const BLOCK_TIME_CACHE_TTL_MS = 60_000
const blockTimeCache = new Map<string, { timestamp: number; fetchedAt: number }>()
const pendingBlockTimes = new Map<string, DedupPromise<number>>()

async function getCachedBlockTime(height: number): Promise<number> {
  const key = `${DEFAULT_NETWORK}:${height}`
  const cached = blockTimeCache.get(key)
  if (cached) {
    const age = Date.now() - cached.fetchedAt
    if (age >= 0 && age < BLOCK_TIME_CACHE_TTL_MS) return cached.timestamp
    blockTimeCache.delete(key)
  }

  let pending = pendingBlockTimes.get(key)
  if (!pending) {
    pending = new DedupPromise<number>()
    pendingBlockTimes.set(key, pending)
  }

  try {
    return await pending.run(
      () => zcashWalletRuntimeClient.getBlockTime(height),
      timestamp => {
        blockTimeCache.set(key, { timestamp, fetchedAt: Date.now() })
      }
    )
  } finally {
    if (pendingBlockTimes.get(key) === pending) pendingBlockTimes.delete(key)
  }
}

export function ZcashSettings() {
  const openResyncZcash = useResyncZcash()
  const [searchParams] = useSearchParams()
  const walletId = searchParams.get('walletId')
  const accountId = searchParams.get('accountId')
  const { wallets, currentWalletId, currentAccountId, accountDisplayNames } = useWalletStore()
  const { copyToClipboard, showToast, isCopied } = useCopyToClipboard()
  const [network, setNetwork] = useState<AccountNetworkView | null>(null)
  const [addressLoading, setAddressLoading] = useState(true)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [birthdayHeight, setBirthdayHeight] = useState<number | null>(null)
  const [birthdayDate, setBirthdayDate] = useState<string | null>(null)
  const [birthdayLoading, setBirthdayLoading] = useState(true)
  const [activeAccount, setActiveAccount] = useState(false)
  const [canRotateShielded, setCanRotateShielded] = useState(false)
  const [isRotatingShielded, setIsRotatingShielded] = useState(false)
  const [waitingForSync, setWaitingForSync] = useState<boolean | null>(null)
  const [rotationError, setRotationError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectingAddress, setSelectingAddress] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const wallet = walletId ? wallets.find(candidate => candidate.id === walletId) : null
  const account =
    wallet && accountId ? wallet.accounts.find(candidate => candidate.id === accountId) : null
  const isCurrentAccount = walletId === currentWalletId && accountId === currentAccountId
  const shieldedAddresses = account?.networkShieldedReceiveAddressHistory?.[DEFAULT_NETWORK] ?? []
  const orderedAddresses = [...(network?.addresses ?? [])].sort(
    (left, right) => Number(left.privacy === 'shielded') - Number(right.privacy === 'shielded')
  )
  const accountName =
    walletId && accountId && account
      ? getAccountDisplayName(walletId, accountId, account.name, accountDisplayNames)
      : ''
  const derivationPaths = getZcashDerivationPaths(
    DEFAULT_NETWORK,
    network?.accountDerivationPath,
    account?.networkAddresses?.[DEFAULT_NETWORK] ?? account?.addresses,
    network?.addresses.find(address => address.scheme === 'zcash-transparent-p2pkh')?.value
  )

  useEffect(() => {
    let cancelled = false
    setNetwork(null)
    setAddressError(null)
    setRotationError(null)
    setHistoryOpen(false)
    setHistoryError(null)
    setActiveAccount(false)
    setCanRotateShielded(false)
    setAddressLoading(Boolean(walletId && accountId))

    if (!walletId || !accountId) {
      setAddressLoading(false)
      return () => {
        cancelled = true
      }
    }

    accountNetworksClient
      .getCatalog()
      .then(catalog => {
        if (cancelled) return
        const entry = catalog?.accounts.find(
          candidate => candidate.walletId === walletId && candidate.accountId === accountId
        )
        if (!entry) {
          setAddressError('Zcash is not available for this account.')
          return
        }
        const zcashNetwork = entry.networks.find(candidate => candidate.chain.family === 'zcash')
        if (!zcashNetwork) {
          setAddressError('Zcash is not available for this account.')
          return
        }
        setNetwork(zcashNetwork)
        setActiveAccount(entry.active)
        setCanRotateShielded(
          entry.walletSource.kind === 'software' ||
            (entry.walletSource.kind === 'hardware' &&
              entry.walletSource.hardware.capabilities.includes('zcash'))
        )
      })
      .catch(() => {
        if (!cancelled) setAddressError('Unable to load Zcash addresses for this account.')
      })
      .finally(() => {
        if (!cancelled) setAddressLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [walletId, accountId])

  useEffect(() => {
    let cancelled = false
    setBirthdayHeight(null)
    setBirthdayDate(null)
    setBirthdayLoading(Boolean(walletId && accountId && account))

    if (!walletId || !accountId || !account) {
      setBirthdayLoading(false)
      return () => {
        cancelled = true
      }
    }

    const loadBirthday = async () => {
      try {
        let height = account.birthdayHeight || 0
        let source = height > 0 ? 'stored' : 'none'

        if (height <= 0) {
          const resolved = await zcashWalletRuntimeClient.resolveBirthdayHeight(walletId, accountId)
          height = resolved.height
          source = resolved.source
        }

        if (cancelled) return
        setBirthdayHeight(height > 0 ? height : null)

        if (height <= 0 || source === 'fallback') return

        try {
          const timestamp = await getCachedBlockTime(height)
          if (!cancelled) {
            setBirthdayDate(
              getBirthdayDateFromBlockTimestamp(timestamp)?.format('MMM D, YYYY') ?? null
            )
          }
        } catch {
          if (!cancelled) setBirthdayDate(null)
        }
      } catch {
        if (!cancelled) {
          setBirthdayHeight(null)
          setBirthdayDate(null)
        }
      } finally {
        if (!cancelled) setBirthdayLoading(false)
      }
    }

    void loadBirthday()

    return () => {
      cancelled = true
    }
  }, [walletId, accountId, account?.birthdayHeight])

  useEffect(() => {
    if (!isRotatingShielded || !walletId || !accountId) return
    let cancelled = false
    let progressEvents = 0
    const onSyncProgress = (
      message: { type?: string; walletId?: string; isSyncing?: boolean },
      sender: chrome.runtime.MessageSender
    ) => {
      if (
        getOwnExtensionSenderContext(sender, chrome.runtime.id) !== 'service-worker' ||
        message.type !== 'SYNC_PROGRESS' ||
        message.walletId !== walletId ||
        typeof message.isSyncing !== 'boolean'
      ) {
        return
      }
      progressEvents += 1
      setWaitingForSync(message.isSyncing)
    }

    chrome.runtime.onMessage.addListener(onSyncProgress)
    void chrome.runtime
      .sendMessage({ type: 'GET_SYNC_STATE', walletId, accountId })
      .then(snapshot => {
        if (!cancelled && progressEvents === 0 && typeof snapshot?.isSyncing === 'boolean') {
          setWaitingForSync(snapshot.isSyncing)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
      chrome.runtime.onMessage.removeListener(onSyncProgress)
    }
  }, [isRotatingShielded, walletId, accountId])

  if (!walletId || !accountId || !wallet || !account) {
    return (
      <div className="page-container">
        <PageHeader title="Zcash settings" showBack />
        <div className="flex flex-1 items-center justify-center px-5">
          <p className="text-center text-muted">No account available</p>
        </div>
      </div>
    )
  }

  const rotateShieldedAddress = async () => {
    if (!activeAccount || !canRotateShielded || isRotatingShielded || selectingAddress) return
    setRotationError(null)
    setWaitingForSync(null)
    setIsRotatingShielded(true)
    try {
      const addresses = await zcashWalletRuntimeClient.rotateShieldedReceiveAddress(
        wallet.id,
        account.id
      )
      setNetwork(current =>
        current
          ? {
              ...current,
              addresses: current.addresses.map(address =>
                address.privacy === 'shielded' ? { ...address, value: addresses.shielded } : address
              )
            }
          : current
      )
    } catch (error) {
      setRotationError(classifyError(error).userMessage)
    } finally {
      setIsRotatingShielded(false)
    }
  }

  const selectHistoryAddress = async (shielded: string) => {
    if (!activeAccount || isRotatingShielded || selectingAddress) return
    setHistoryError(null)
    setSelectingAddress(shielded)
    try {
      const addresses = await zcashWalletRuntimeClient.setShieldedReceiveAddress(
        wallet.id,
        account.id,
        shielded
      )
      setNetwork(current =>
        current
          ? {
              ...current,
              addresses: current.addresses.map(address =>
                address.privacy === 'shielded' ? { ...address, value: addresses.shielded } : address
              )
            }
          : current
      )
      setHistoryOpen(false)
    } catch (error) {
      setHistoryError(classifyError(error).userMessage)
    } finally {
      setSelectingAddress(null)
    }
  }

  return (
    <div className="page-container">
      <CopyToast show={showToast} />
      <PageHeader title="Zcash settings" showBack />
      <ShieldedAddressHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        addresses={shieldedAddresses}
        current={account.networkAddresses?.[DEFAULT_NETWORK] ?? account.addresses}
        disabled={!activeAccount || isRotatingShielded}
        selectingAddress={selectingAddress}
        error={historyError}
        onSelect={address => void selectHistoryAddress(address)}
        onCopy={(address, index) => void copyToClipboard(address, `history-${index}`)}
        isCopied={index => isCopied(`history-${index}`)}
      />
      <div className="page-content space-y-3 pt-4">
        <section
          className="flex min-w-0 items-center justify-between gap-4 px-1 pb-2"
          aria-label="Zcash account"
        >
          <span className="text-sm">Account</span>
          <div className="flex min-w-0 items-center gap-2">
            {network ? (
              <ChainIcon
                chain={accountNetworkIconChain(network)}
                width={28}
                height={28}
                className="shrink-0 rounded-lg"
              />
            ) : (
              <Skeleton className="size-7 shrink-0 rounded-lg" />
            )}
            <span className="truncate text-sm" title={accountName}>
              {accountName}
            </span>
          </div>
        </section>

        <section
          className="rounded-xl border border-border bg-card p-3"
          aria-labelledby="zcash-birthday-heading"
        >
          <h2 id="zcash-birthday-heading" className="mb-3 text-xs text-muted">
            Sync start
          </h2>
          <div className="flex min-h-10 items-center justify-between gap-3 text-sm">
            <span>Birthday date</span>
            {birthdayLoading ? (
              <Skeleton className="h-4 w-24" />
            ) : (
              <span>{birthdayDate ?? '—'}</span>
            )}
          </div>
          <div className="flex min-h-10 items-center justify-between gap-3 text-sm">
            <span>Birthday height</span>
            {birthdayLoading ? (
              <Skeleton className="h-4 w-20" />
            ) : birthdayHeight ? (
              <button
                type="button"
                aria-label="Copy birthday height"
                className="wallet-interactive inline-flex min-h-8 items-center gap-2 rounded text-xs hover:text-primary"
                onClick={() => void copyToClipboard(String(birthdayHeight), 'birthday')}
              >
                <span className="font-mono">{birthdayHeight.toLocaleString()}</span>
                <CopyFeedbackIcon
                  copied={isCopied('birthday')}
                  width={15}
                  height={15}
                  className="text-muted"
                />
              </button>
            ) : (
              <span className="text-muted">—</span>
            )}
          </div>
          {isCurrentAccount && (
            <Button
              type="button"
              variant="outline"
              className="mt-2 h-8 w-full gap-1.5 border-border bg-white/[0.03] text-xs text-muted"
              onClick={() =>
                void openResyncZcash(wallet.id, account.id, account.birthdayHeight || 0)
              }
            >
              <Icon icon="lucide:refresh-cw" width={14} height={14} />
              Resync Zcash
            </Button>
          )}
        </section>

        <section
          className="rounded-xl border border-border bg-card p-3"
          aria-labelledby="zcash-addresses-heading"
        >
          <h2 id="zcash-addresses-heading" className="mb-3 text-xs text-muted">
            Address
          </h2>
          {addressLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : addressError ? (
            <p role="alert" className="py-3 text-sm text-muted">
              {addressError}
            </p>
          ) : (
            orderedAddresses.map(address => (
              <div
                key={`${address.scheme}:${address.value}`}
                className="flex min-h-10 min-w-0 items-center justify-between gap-3"
              >
                <AccountDomainBadge
                  domain={address.privacy === 'transparent' ? 'public' : 'shield'}
                  chainFamily="zcash"
                />
                <button
                  type="button"
                  aria-label={`Copy Zcash ${address.privacy} address`}
                  title={`Copy ${privacyLabel(address)} address: ${address.value}`}
                  className="wallet-interactive flex min-w-0 items-center gap-2 rounded py-1 text-xs hover:text-primary"
                  onClick={() => void copyToClipboard(address.value, `zcash-${address.scheme}`)}
                >
                  <span className="truncate font-mono">{formatSortAddress(address.value)}</span>
                  <CopyFeedbackIcon
                    copied={isCopied(`zcash-${address.scheme}`)}
                    width={15}
                    height={15}
                    className="shrink-0 text-muted"
                  />
                </button>
              </div>
            ))
          )}
          {!addressLoading && !addressError && network && (
            <div className="mt-2 flex items-center gap-2">
              {isCurrentAccount && (
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 min-w-0 flex-1 gap-1.5 border-border bg-white/[0.03] px-2 text-[11px] text-muted"
                  isLoading={isRotatingShielded}
                  disabled={!activeAccount || !canRotateShielded || selectingAddress !== null}
                  onClick={() => void rotateShieldedAddress()}
                >
                  <Icon icon="lucide:refresh-cw" width={14} height={14} />
                  <span aria-live="polite" className="truncate">
                    {isRotatingShielded
                      ? waitingForSync === null
                        ? 'Preparing address...'
                        : waitingForSync
                          ? 'Waiting for sync...'
                          : 'Generating address...'
                      : 'Generate new shielded address'}
                  </span>
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                className="h-8 w-8 shrink-0 border-border bg-white/[0.03] p-0 text-muted"
                aria-label="Shielded address history"
                title="Shielded address history"
                aria-haspopup="dialog"
                onClick={() => {
                  setHistoryError(null)
                  setHistoryOpen(true)
                }}
              >
                <Icon icon="lucide:history" width={16} height={16} />
              </Button>
            </div>
          )}
          {rotationError && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {rotationError}
            </p>
          )}
        </section>

        {derivationPaths.account && (
          <section
            className="rounded-xl border border-border bg-card p-3"
            aria-labelledby="zcash-paths-heading"
          >
            <h2 id="zcash-paths-heading" className="mb-3 text-xs text-muted">
              Derivation path
            </h2>
            <button
              type="button"
              className="wallet-interactive flex min-h-10 w-full min-w-0 items-center justify-between gap-3 rounded text-left text-xs"
              onClick={() => void copyToClipboard(derivationPaths.account!, 'account-path')}
              aria-label="Copy Zcash account derivation path"
            >
              <span className="min-w-0 truncate">Account derivation path</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-mono">{derivationPaths.account}</span>
                <CopyFeedbackIcon
                  copied={isCopied('account-path')}
                  width={15}
                  height={15}
                  className="text-muted"
                />
              </span>
            </button>
            {derivationPaths.transparent && (
              <button
                type="button"
                className="wallet-interactive flex min-h-10 w-full min-w-0 items-center justify-between gap-3 rounded text-left text-xs"
                onClick={() =>
                  void copyToClipboard(derivationPaths.transparent!, 'transparent-path')
                }
                aria-label="Copy Zcash transparent address derivation path"
              >
                <span className="min-w-0 truncate" title="Transparent address derivation path">
                  Transparent address derivation path
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono">{derivationPaths.transparent}</span>
                  <CopyFeedbackIcon
                    copied={isCopied('transparent-path')}
                    width={15}
                    height={15}
                    className="text-muted"
                  />
                </span>
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
