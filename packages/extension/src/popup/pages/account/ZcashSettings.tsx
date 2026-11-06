import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '@iconify/react'
import { AddressTypeLabel } from '../../components/account/AddressType'
import { ShieldedAddressHistorySheet } from '../../components/account/ShieldedAddressHistorySheet'
import { ChainIcon } from '../../components/common/ChainIcon'
import { CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import {
  accountNetworkIconChain,
  accountNetworkLabel
} from '@/popup/services/account-network-presentation'
import {
  accountNetworksClient,
  type AccountNetworkAddressView,
  type AccountNetworkView
} from '../../services/account-networks-client'
import { useResyncZcash } from '../../hooks/useResyncZcash'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { classifyError } from '@/lib/errors'
import { getAccountDisplayName } from '@/lib/format'
import { getBirthdayDateFromBlockTimestamp } from '@/lib/zcash-birthday'
import { getOwnExtensionSenderContext } from '@/lib/runtime-message-security'
import { useWalletStore } from '@/store/wallet-store'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { getZcashDerivationPaths } from '@/lib/zcash-derivation'

function privacyLabel(address: AccountNetworkAddressView): 'Shielded' | 'Transparent' {
  return address.privacy === 'transparent' ? 'Transparent' : 'Shielded'
}

export function ZcashSettings() {
  const openResyncZcash = useResyncZcash()
  const [searchParams] = useSearchParams()
  const walletId = searchParams.get('walletId')
  const accountId = searchParams.get('accountId')
  const { wallets, currentWalletId, currentAccountId, accountDisplayNames } = useWalletStore()
  const { copyToClipboard, showToast } = useCopyToClipboard()
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
          const timestamp = await zcashWalletRuntimeClient.getBlockTime(height)
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
      <CopyToast show={showToast} message="Copied" />
      <PageHeader title="Zcash settings" showBack />
      <ShieldedAddressHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        addresses={shieldedAddresses}
        current={account.addresses}
        disabled={!activeAccount || isRotatingShielded}
        selectingAddress={selectingAddress}
        error={historyError}
        onSelect={address => void selectHistoryAddress(address)}
        onCopy={address => void copyToClipboard(address)}
      />

      <div className="page-content space-y-5 pt-5">
        <section
          className="rounded-2xl border border-border bg-card p-4"
          aria-label="Zcash account"
        >
          <div className="flex items-center gap-3">
            {network ? (
              <ChainIcon
                chain={accountNetworkIconChain(network)}
                width={40}
                height={40}
                className="shrink-0 rounded-xl"
              />
            ) : (
              <Skeleton className="size-10 shrink-0 rounded-xl" />
            )}
            <div className="min-w-0">
              <h2 className="text-lg font-medium text-foreground">
                {network ? accountNetworkLabel(network) : 'Zcash'}
              </h2>
              <p className="truncate text-sm text-muted">{accountName}</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="zcash-birthday-heading">
          <h2 id="zcash-birthday-heading" className="mb-2 text-xs font-medium text-muted">
            Sync start
          </h2>
          <div className="rounded-2xl bg-card px-4 py-3.5">
            <div className="min-w-0 space-y-1">
              <span className="text-sm text-muted">Birthday date</span>
              <div className="flex min-h-8 min-w-0 items-center justify-between gap-2">
                {birthdayLoading ? (
                  <Skeleton className="h-5 w-28" />
                ) : birthdayHeight ? (
                  <>
                    <span className="min-w-0 text-sm text-foreground">{birthdayDate ?? '—'}</span>
                    <button
                      type="button"
                      aria-label="Copy birthday height"
                      className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-mono text-xs text-muted transition-colors hover:bg-foreground/5"
                      onClick={() => void copyToClipboard(String(birthdayHeight))}
                    >
                      #{birthdayHeight.toLocaleString()}
                      <Icon icon="lucide:copy" width={13} height={13} />
                    </button>
                  </>
                ) : (
                  <span className="text-sm text-muted">Unknown</span>
                )}
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="zcash-addresses-heading">
          <h2 id="zcash-addresses-heading" className="mb-2 text-xs font-medium text-muted">
            Addresses
          </h2>
          <div className="space-y-2">
            {addressLoading ? (
              <>
                <Skeleton className="h-[92px] w-full rounded-2xl" />
                <Skeleton className="h-[92px] w-full rounded-2xl" />
              </>
            ) : addressError ? (
              <p
                role="alert"
                className="rounded-2xl bg-card px-4 py-6 text-center text-sm text-muted"
              >
                {addressError}
              </p>
            ) : (
              network?.addresses.map(address => (
                <div
                  key={`${address.scheme}:${address.value}`}
                  className="rounded-2xl bg-card px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <AddressTypeLabel
                      type={address.privacy === 'transparent' ? 'transparent' : 'shielded'}
                    />
                    <button
                      type="button"
                      aria-label={`Copy Zcash ${address.privacy} address`}
                      title={`Copy ${privacyLabel(address)} address`}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/10 hover:text-foreground"
                      onClick={() => void copyToClipboard(address.value)}
                    >
                      <Icon icon="lucide:copy" width={17} height={17} />
                    </button>
                  </div>
                  <p
                    className="mt-2 break-all font-mono text-[11px] leading-relaxed text-muted"
                    title={address.value}
                  >
                    {address.value}
                  </p>
                </div>
              ))
            )}
          </div>
          {!addressLoading && !addressError && network && (
            <div className="mt-3">
              <Button
                type="button"
                variant="outline"
                className="h-[45px] w-full"
                isLoading={isRotatingShielded}
                disabled={!activeAccount || !canRotateShielded || selectingAddress !== null}
                onClick={() => void rotateShieldedAddress()}
              >
                <Icon icon="lucide:refresh-cw" width={17} height={17} />
                <span aria-live="polite">
                  {isRotatingShielded
                    ? waitingForSync === null
                      ? 'Preparing address...'
                      : waitingForSync
                        ? 'Waiting for sync...'
                        : 'Generating address...'
                    : 'Generate new shielded address'}
                </span>
              </Button>
              {rotationError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {rotationError}
                </p>
              )}
            </div>
          )}
          {shieldedAddresses.length > 1 && (
            <div className="mt-4">
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => {
                  setHistoryError(null)
                  setHistoryOpen(true)
                }}
                className="flex w-full items-center justify-between py-2 text-sm text-muted hover:text-foreground"
              >
                <span>Shielded addresses ({shieldedAddresses.length})</span>
                <Icon icon="lucide:history" width={16} height={16} />
              </button>
            </div>
          )}
        </section>

        {derivationPaths.account && (
          <section aria-labelledby="zcash-paths-heading">
            <h2 id="zcash-paths-heading" className="mb-2 text-xs font-medium text-muted">
              Derivation paths
            </h2>
            <div className="space-y-2">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-md bg-card px-4 py-3 text-left"
                onClick={() => void copyToClipboard(derivationPaths.account!)}
                aria-label="Copy Zcash account derivation path"
              >
                <span className="min-w-0">
                  <span className="block text-xs text-muted">Account derivation path</span>
                  <span className="break-all font-mono text-xs">{derivationPaths.account}</span>
                </span>
                <Icon icon="lucide:copy" width={15} height={15} className="shrink-0 text-muted" />
              </button>
              {derivationPaths.transparent && (
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-md bg-card px-4 py-3 text-left"
                  onClick={() => void copyToClipboard(derivationPaths.transparent!)}
                  aria-label="Copy Zcash transparent address derivation path"
                >
                  <span className="min-w-0">
                    <span className="block text-xs text-muted">
                      Transparent address derivation path
                    </span>
                    <span className="break-all font-mono text-xs">
                      {derivationPaths.transparent}
                    </span>
                  </span>
                  <Icon icon="lucide:copy" width={15} height={15} className="shrink-0 text-muted" />
                </button>
              )}
            </div>
          </section>
        )}

        {isCurrentAccount && (
          <section className="pb-2" aria-labelledby="zcash-resync-heading">
            <h2 id="zcash-resync-heading" className="mb-2 text-xs font-medium text-muted">
              Maintenance
            </h2>
            <Button
              type="button"
              variant="outline"
              className="h-[45px] w-full"
              onClick={() =>
                void openResyncZcash(wallet.id, account.id, account.birthdayHeight || 0)
              }
            >
              <Icon icon="lucide:refresh-cw" width={17} height={17} />
              Resync Zcash
            </Button>
          </section>
        )}
      </div>
    </div>
  )
}
