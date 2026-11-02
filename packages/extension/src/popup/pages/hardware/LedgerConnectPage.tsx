import { InlineError } from '@/popup/components/common/InlineError'
import { ANALYTICS_EVENTS, sendAnalyticsEvent } from '@/lib/analytics'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import { ChainIcon } from '../../components/common/ChainIcon'
import { PasswordInput } from '../../components/common/PasswordInput'
import { PasswordStrength } from '../../components/common/PasswordStrength'
import { SyncOptionsModal } from '../../components/onboarding/SyncOptionsModal'
import { openModal } from '../../provider/ModalManager'
import {
  accountNetworksClient,
  type AccountNetworksCatalogView
} from '../../services/account-networks-client'
import { ledgerHardwareProvisioningClient } from '../../services/hardware-provisioning-client'
import { BetaInviteHardwareDoneButton } from '../../components/onboarding/BetaInviteBinding'
import { exportLedgerWalletAccounts } from '../../services/ledger-account-export'
import {
  type LedgerChainFamily,
  type LedgerHardwareCredential,
  type LedgerPublicAccount
} from '@/core/wallet/hardware-wallet-data'
import {
  discoverLedger,
  type LedgerSessionOptions,
  type LedgerTransport
} from '@/lib/ledger/device'
import type { LedgerDerivationMode } from '@/core/wallet/ledger-derivation-path'
import {
  loadLedgerAccountCandidates,
  LEDGER_PATH_MODES,
  type LedgerAccountCandidate,
  type LedgerSelectableFamily
} from '../../services/ledger-account-discovery'
import {
  readLedgerAccountPreview,
  type LedgerAccountPreview
} from '../../services/ledger-account-preview'
import { LedgerAccountPicker } from './LedgerAccountPicker'
import {
  ledgerAppName,
  ledgerDeviceStatus,
  type LedgerDeviceStatus
} from '../../services/ledger-device-status'
import { cn } from '@/lib/utils'
import { getNewPasswordValidationError, isNewPasswordValid } from '@/core/wallet/password-policy'
import { useWalletStore } from '@/store/wallet-store'
import { nextHardwareWalletName } from '@/lib/hardware-connect-options'
import {
  MAX_LEDGER_ACCOUNT_INDEX,
  parseLedgerAccountIndex,
  ledgerCatalogWallets,
  ledgerProvisioningCredential,
  ledgerLogicalAccountIndex,
  ledgerRegisteredFamilies,
  ledgerCanAddZcashAccount,
  ledgerAvailableFamilies,
  ledgerFamilyChoices,
  ledgerSelectedPaths
} from './ledger-connect-model'

const CHAIN_NAMES: Record<LedgerChainFamily, string> = {
  zcash: 'Zcash',
  evm: 'EVM',
  bitcoin: 'Bitcoin',
  solana: 'Solana',
  near: 'NEAR'
}
export function LedgerConnectPage() {
  const { replace } = useNavigate()
  const network = useWalletStore(state => state.currentNetwork)
  const retainedWalletCount = useWalletStore(state => state.wallets.length)
  const [catalog, setCatalog] = useState<AccountNetworksCatalogView | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [credentialLoading, setCredentialLoading] = useState(false)
  const [catalogReadError, setCatalogReadError] = useState('')
  const [credentialReadError, setCredentialReadError] = useState('')
  const [catalogLoadAttempt, setCatalogLoadAttempt] = useState(0)
  const [credentialLoadAttempt, setCredentialLoadAttempt] = useState(0)
  const loading = catalogLoading || credentialLoading
  const [catalogAvailable, setCatalogAvailable] = useState(false)
  const [step, setStep] = useState<'connect' | 'waiting' | 'accounts' | 'configure' | 'success'>(
    'connect'
  )
  const [targetWalletId, setTargetWalletId] = useState('')
  const [targetAccount, setTargetAccount] = useState('0')
  const [existingCredential, setExistingCredential] = useState<
    LedgerHardwareCredential | undefined
  >()
  const [families, setFamilies] = useState<readonly LedgerChainFamily[]>(['zcash'])
  const [deviceIndex, setDeviceIndex] = useState('0')
  const [exported, setExported] = useState<{
    credential: LedgerHardwareCredential
    anchorProof?: LedgerPublicAccount
  } | null>(null)
  const [walletName, setWalletName] = useState('Ledger Wallet 1')
  const walletNameEdited = useRef(false)
  const newWalletName = useRef('Ledger Wallet 1')
  const [birthdayHeight, setBirthdayHeight] = useState<number | undefined>()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [deviceStatus, setDeviceStatus] = useState<LedgerDeviceStatus>({
    message: 'Select your Ledger',
    awaitingDevice: false
  })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [pickerFamily, setPickerFamily] = useState<LedgerSelectableFamily>('evm')
  const [pathMode, setPathMode] = useState<LedgerDerivationMode>('ledger-live')
  const [pageStart, setPageStart] = useState(0)
  const [candidates, setCandidates] = useState<readonly LedgerAccountCandidate[]>([])
  const [picked, setPicked] = useState<LedgerAccountCandidate | null>(null)
  const [previews, setPreviews] = useState<Readonly<Record<string, LedgerAccountPreview>>>({})
  const [readingAccounts, setReadingAccounts] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const previewAbort = useRef<AbortController | null>(null)
  const selectedAccounts = useRef<readonly LedgerPublicAccount[]>([])
  const connection = useRef<{
    device: NonNullable<LedgerSessionOptions['device']>
    transport: LedgerTransport
    families: readonly LedgerChainFamily[]
    pickers: readonly LedgerSelectableFamily[]
  } | null>(null)
  const connecting = useRef(false)
  const provisioning = useRef(false)
  const wallets = ledgerCatalogWallets(catalog)
  const target = wallets.find(wallet => wallet.id === targetWalletId)
  const accountIndex = ledgerLogicalAccountIndex(targetAccount, target?.accounts ?? [])
  const registeredFamilies = ledgerRegisteredFamilies(existingCredential, accountIndex, network)
  const canAddZcash = ledgerCanAddZcashAccount(existingCredential, accountIndex, network)
  const availableFamilies = ledgerAvailableFamilies(network)
  const selectedFamilies = families.filter(
    family => availableFamilies.includes(family) && (family !== 'zcash' || canAddZcash)
  )
  const parsedDeviceIndex = parseLedgerAccountIndex(deviceIndex)
  const firstWallet = !loading && !catalog?.accounts.length && retainedWalletCount === 0
  const familyChoices = ledgerFamilyChoices(availableFamilies)
  useEffect(() => {
    if (catalog && !targetWalletId && !walletNameEdited.current) {
      const suggested = nextHardwareWalletName('ledger', catalog.accounts)
      newWalletName.current = suggested
      setWalletName(suggested)
    }
  }, [catalog, targetWalletId])
  useEffect(() => {
    let disposed = false
    setCatalogLoading(true)
    setCatalogAvailable(false)
    setCatalogReadError('')
    void accountNetworksClient
      .getCatalog()
      .then(result => {
        if (!disposed) {
          setCatalog(result)
          setCatalogAvailable(true)
        }
      })
      .catch(cause => {
        if (!disposed)
          setCatalogReadError(cause instanceof Error ? cause.message : 'Wallet check failed')
      })
      .finally(() => {
        if (!disposed) setCatalogLoading(false)
      })
    return () => {
      disposed = true
      abort.current?.abort()
      previewAbort.current?.abort()
    }
  }, [catalogLoadAttempt])
  useEffect(() => {
    let disposed = false
    setExistingCredential(undefined)
    setCredentialReadError('')
    if (!targetWalletId) {
      setCredentialLoading(false)
      return
    }
    setCredentialLoading(true)
    void ledgerHardwareProvisioningClient
      .getCredential(targetWalletId)
      .then(credential => {
        if (!disposed) setExistingCredential(credential)
      })
      .catch(cause => {
        if (!disposed)
          setCredentialReadError(
            cause instanceof Error ? cause.message : 'Ledger Wallet unavailable'
          )
      })
      .finally(() => {
        if (!disposed) setCredentialLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [targetWalletId, credentialLoadAttempt])
  const cancelConnection = () => {
    if (provisioning.current) return
    abort.current?.abort()
    previewAbort.current?.abort()
    abort.current = null
    connecting.current = false
    setReadingAccounts(false)
    setError('')
    setCandidates([])
    setPicked(null)
    setExported(null)
    connection.current = null
    selectedAccounts.current = []
    setStep('connect')
  }
  useEffect(() => {
    return () => {
      abort.current?.abort()
      previewAbort.current?.abort()
      connection.current = null
      selectedAccounts.current = []
    }
  }, [network])

  const refreshPreviews = (page: readonly LedgerAccountCandidate[]) => {
    previewAbort.current?.abort()
    const controller = new AbortController()
    previewAbort.current = controller
    setPreviews({})
    const inspect = async () => {
      // Read two addresses at a time; device enumeration stays responsive.
      for (let index = 0; index < page.length; index += 2) {
        await Promise.all(
          page.slice(index, index + 2).map(async candidate => {
            const preview = await readLedgerAccountPreview(
              candidate.account,
              network,
              controller.signal
            )
            if (!controller.signal.aborted)
              setPreviews(current => ({
                ...current,
                [candidate.account.derivationPath]: preview
              }))
          })
        )
        controller.signal.throwIfAborted()
      }
    }
    void inspect().catch(() => {})
  }

  const readPage = async (
    family: LedgerSelectableFamily,
    mode: LedgerDerivationMode,
    start: number,
    showWaiting = false
  ) => {
    const current = connection.current
    const controller = abort.current
    if (!current || !controller || accountIndex === null || connecting.current) return
    connecting.current = true
    setReadingAccounts(true)
    setError('')
    setCandidates([])
    setPicked(null)
    previewAbort.current?.abort()
    setPreviews({})
    setPickerFamily(family)
    setPathMode(mode)
    setPageStart(start)
    const app = ledgerAppName(family, network)
    setDeviceStatus(ledgerDeviceStatus(app))
    if (showWaiting) setStep('waiting')
    try {
      controller.signal.throwIfAborted()
      const page = await loadLedgerAccountCandidates({
        transport: current.transport,
        device: current.device,
        signal: controller.signal,
        family,
        mode,
        start,
        network,
        logicalAccountIndex: accountIndex,
        existing: existingCredential,
        onInteraction: interaction => {
          if (!controller.signal.aborted) setDeviceStatus(ledgerDeviceStatus(app, interaction))
        }
      })
      controller.signal.throwIfAborted()
      setCandidates(page)
      setStep('accounts')
      refreshPreviews(page)
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Unable to read Ledger accounts')
        setStep('accounts')
      }
    } finally {
      if (abort.current === controller) {
        connecting.current = false
        if (!controller.signal.aborted) setReadingAccounts(false)
      }
    }
  }

  const confirmAccounts = async () => {
    const current = connection.current
    const controller = abort.current
    if (
      !current ||
      !controller ||
      accountIndex === null ||
      parsedDeviceIndex === null ||
      connecting.current
    )
      return
    connecting.current = true
    setReadingAccounts(true)
    setError('')
    previewAbort.current?.abort()
    setStep('waiting')
    try {
      const result = await exportLedgerWalletAccounts({
        transport: current.transport,
        device: current.device,
        network,
        families: current.families,
        deviceAccountIndex: parsedDeviceIndex,
        accountIndex,
        derivationPaths: ledgerSelectedPaths(selectedAccounts.current),
        expectedAccounts: selectedAccounts.current,
        existing: existingCredential,
        signal: controller.signal,
        onStep: (app, interaction) => {
          if (!controller.signal.aborted) setDeviceStatus(ledgerDeviceStatus(app, interaction))
        }
      })
      controller.signal.throwIfAborted()
      setExported(result)
      setStep('configure')
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Ledger confirmation failed')
        setStep(current.pickers.length ? 'accounts' : 'connect')
      }
    } finally {
      if (abort.current === controller) {
        connecting.current = false
        if (!controller.signal.aborted) setReadingAccounts(false)
      }
    }
  }

  const continueAccounts = async () => {
    const current = connection.current
    if (!picked || !current || connecting.current) return
    selectedAccounts.current = [
      ...selectedAccounts.current.filter(account => account.family !== pickerFamily),
      picked.account
    ]
    const next = current.pickers[current.pickers.indexOf(pickerFamily) + 1]
    if (next) await readPage(next, LEDGER_PATH_MODES[next][0].value, parsedDeviceIndex ?? 0, true)
    else await confirmAccounts()
  }
  const detect = async (transport: LedgerTransport) => {
    if (
      parsedDeviceIndex === null ||
      accountIndex === null ||
      !catalogAvailable ||
      loading ||
      connecting.current ||
      selectedFamilies.length === 0
    )
      return
    connecting.current = true
    setBirthdayHeight(undefined)
    const controller = new AbortController()
    abort.current = controller
    selectedAccounts.current = []
    setExported(null)
    setError('')
    setDeviceStatus({
      message: 'Select your Ledger in the browser dialog',
      awaitingDevice: true
    })
    setStep('waiting')
    try {
      const device = await discoverLedger(transport, controller.signal)
      controller.signal.throwIfAborted()
      const pickers = selectedFamilies.filter(
        (family): family is LedgerSelectableFamily =>
          family !== 'zcash' && !registeredFamilies.includes(family)
      )
      connection.current = { device, transport, families: selectedFamilies, pickers }
      if (abort.current === controller) connecting.current = false
      if (pickers[0])
        await readPage(pickers[0], LEDGER_PATH_MODES[pickers[0]][0].value, parsedDeviceIndex, true)
      else await confirmAccounts()
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Ledger connection failed')
        setStep('connect')
      }
    } finally {
      if (abort.current === controller) connecting.current = false
    }
  }
  const chooseBirthday = async () => {
    const result = await openModal<{ height?: number; confirmed: boolean } | undefined>({
      title: 'Sync Optimization',
      body: (resolve, close) => (
        <SyncOptionsModal
          initialHeight={birthdayHeight}
          onConfirm={height => {
            resolve({ height, confirmed: true })
            close()
          }}
        />
      )
    })
    if (result?.confirmed) setBirthdayHeight(result.height)
  }
  const create = async () => {
    if (!exported || accountIndex === null || provisioning.current) return
    provisioning.current = true
    setCreating(true)
    setError('')
    try {
      await ledgerHardwareProvisioningClient.provision({
        credential: ledgerProvisioningCredential(
          exported.credential,
          birthdayHeight,
          accountIndex,
          network
        ),
        displayName: walletName.trim(),
        ...(targetWalletId
          ? { existingKeyDomainId: targetWalletId, anchorProof: exported.anchorProof }
          : {}),
        ...(firstWallet ? { password } : {})
      })
      sendAnalyticsEvent(ANALYTICS_EVENTS.HW_CONNECTED, {
        chain: selectedFamilies[0] ?? 'zcash',
        extra: { is_existing_wallet: Boolean(targetWalletId), hardware: 'ledger' }
      })
      if (!targetWalletId) {
        sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
          chain: selectedFamilies[0] ?? 'zcash',
          params: { method: 'hardware' },
          extra: { hardware: 'ledger' }
        })
      }
      setPassword('')
      setConfirmPassword('')
      setStep('success')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ledger setup failed')
    } finally {
      provisioning.current = false
      setCreating(false)
    }
  }
  return (
    <div className="page-container page-container--tab">
      <PageHeader
        title={targetWalletId ? 'Add Ledger Accounts' : 'Connect Ledger'}
        showBack={step === 'connect' || step === 'configure' || step === 'accounts'}
        backDisabled={creating}
        onBack={
          step === 'configure' || step === 'accounts'
            ? cancelConnection
            : () => replace('/hardware/connect')
        }
      />
      {step === 'connect' && (
        <>
          <div className="page-content min-h-0 space-y-4">
            {wallets.length > 0 && (
              <div className={cn('grid gap-3', target && 'grid-cols-2')}>
                <div className="min-w-0">
                  <label htmlFor="ledger-wallet" className="mb-2 block text-sm text-muted">
                    Wallet
                  </label>
                  <select
                    id="ledger-wallet"
                    className="h-[45px] w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                    value={targetWalletId}
                    onChange={event => {
                      const wallet = wallets.find(item => item.id === event.target.value)
                      setTargetWalletId(event.target.value)
                      setTargetAccount(String(wallet?.accounts[0]?.index ?? 0))
                      setFamilies([])
                      setError('')
                      if (wallet) setWalletName(wallet.name)
                      else setWalletName(newWalletName.current)
                    }}
                  >
                    <option value="">New Ledger Wallet</option>
                    {wallets.map(wallet => (
                      <option key={wallet.id} value={wallet.id}>
                        {wallet.name}
                      </option>
                    ))}
                  </select>
                </div>
                {target && (
                  <div className="min-w-0">
                    <label
                      htmlFor="ledger-logical-account"
                      className="mb-2 block text-sm text-muted"
                    >
                      Account
                    </label>
                    <select
                      id="ledger-logical-account"
                      className="h-[45px] w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                      value={targetAccount}
                      onChange={event => setTargetAccount(event.target.value)}
                    >
                      {target.accounts.map(account => (
                        <option key={account.index} value={account.index}>
                          {account.name}
                        </option>
                      ))}
                      <option value="new">Add account</option>
                    </select>
                  </div>
                )}
              </div>
            )}
            <fieldset>
              <legend className="mb-3 text-sm font-medium">Chains</legend>
              <div
                className={cn(
                  'grid grid-cols-3 gap-2 overflow-y-auto',
                  wallets.length > 0 ? 'max-h-40' : 'max-h-56'
                )}
              >
                {familyChoices.map(({ family, enabled }) => {
                  const registered = registeredFamilies.includes(family)
                  const selected = enabled && (!!registered || selectedFamilies.includes(family))
                  return (
                    <button
                      key={family}
                      type="button"
                      disabled={!enabled || !!registered || (family === 'zcash' && !canAddZcash)}
                      aria-pressed={selected}
                      className={cn(
                        'flex h-16 w-full flex-col items-center justify-center gap-1 rounded-xl border px-2 text-center text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 disabled:cursor-default',
                        selected
                          ? 'border-primary bg-primary/5 text-foreground'
                          : enabled
                            ? 'border-border bg-card text-muted hover:text-foreground'
                            : 'border-border bg-card text-muted',
                        enabled ? 'disabled:opacity-50' : 'disabled:opacity-100'
                      )}
                      onClick={() =>
                        setFamilies(current =>
                          current.includes(family)
                            ? current.filter(item => item !== family)
                            : [...current, family]
                        )
                      }
                    >
                      <ChainIcon
                        chain={family}
                        showTooltip={false}
                        aria-hidden="true"
                        className="size-6 shrink-0 rounded-full"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium leading-4">{CHAIN_NAMES[family]}</span>
                        {!enabled ? (
                          <span className="block text-[10px] leading-3 text-muted">
                            Coming soon
                          </span>
                        ) : (
                          registered && (
                            <span className="block text-[10px] leading-3 text-muted">Added</span>
                          )
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>
            <details className="text-sm text-muted">
              <summary className="cursor-pointer py-1">Advanced</summary>
              <label htmlFor="ledger-account-index" className="mb-2 block text-sm text-muted">
                Start account index
              </label>
              <Input
                id="ledger-account-index"
                type="number"
                className="h-[45px]"
                min={0}
                max={MAX_LEDGER_ACCOUNT_INDEX}
                step={1}
                inputMode="numeric"
                value={deviceIndex}
                onChange={event => setDeviceIndex(event.target.value)}
                aria-invalid={parsedDeviceIndex === null}
              />
              {parsedDeviceIndex === null && (
                <p className="mt-2 text-xs text-danger">Enter a valid account index.</p>
              )}
            </details>
            {catalogReadError && (
              <InlineError
                message={`Wallet check: ${catalogReadError}`}
                retrying={loading}
                onRetry={() => setCatalogLoadAttempt(value => value + 1)}
              />
            )}
            {credentialReadError && (
              <InlineError
                message={`Ledger wallet: ${credentialReadError}`}
                retrying={loading}
                onRetry={() => setCredentialLoadAttempt(value => value + 1)}
              />
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
          <div className="page-footer space-y-2">
            <Button
              className="w-full h-[45px]"
              disabled={
                !catalogAvailable ||
                loading ||
                accountIndex === null ||
                parsedDeviceIndex === null ||
                !selectedFamilies.length ||
                (!!targetWalletId && !existingCredential)
              }
              onClick={() => void detect('usb')}
            >
              Connect Ledger
            </Button>
            <button
              type="button"
              className="w-full py-2 text-sm font-medium text-primary hover:text-primary/80 disabled:opacity-50"
              disabled={
                !catalogAvailable ||
                loading ||
                accountIndex === null ||
                parsedDeviceIndex === null ||
                !selectedFamilies.length ||
                (!!targetWalletId && !existingCredential)
              }
              onClick={() => void detect('bluetooth')}
            >
              Use Bluetooth instead
            </button>
          </div>
        </>
      )}
      {step === 'accounts' && (
        <>
          <LedgerAccountPicker
            family={pickerFamily}
            mode={pathMode}
            start={pageStart}
            candidates={candidates}
            selectedPath={picked?.account.derivationPath}
            previews={previews}
            busy={readingAccounts}
            busyMessage={deviceStatus.message}
            error={error}
            onSelect={setPicked}
            onMode={mode => void readPage(pickerFamily, mode, 0)}
            onPage={start => void readPage(pickerFamily, pathMode, start)}
            onRetryPreview={() => refreshPreviews(candidates)}
          />
          <div className="page-footer space-y-2">
            <Button
              className="w-full"
              disabled={!picked || readingAccounts}
              onClick={() => void continueAccounts()}
            >
              Continue
            </Button>
            <Button className="w-full" variant="outline" onClick={cancelConnection}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {step === 'waiting' && (
        <>
          <div
            className="page-content flex flex-col items-center justify-center gap-4 text-center"
            role="status"
            aria-live="polite"
          >
            <Icon
              icon={deviceStatus.awaitingDevice ? 'lucide:usb' : 'lucide:loader-2'}
              width={32}
              className={deviceStatus.awaitingDevice ? 'text-primary' : 'animate-spin text-primary'}
            />
            <p>{deviceStatus.message}</p>
          </div>
          <div className="page-footer space-y-2">
            <Button className="w-full" variant="outline" onClick={cancelConnection}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {step === 'configure' && exported && (
        <>
          <div className="page-content space-y-4 pt-4">
            <div className="flex items-center gap-3">
              <Icon icon="lucide:check-circle-2" width={22} className="text-primary" />
              <span>{exported.credential.deviceName}</span>
            </div>
            {!targetWalletId && (
              <div>
                <label htmlFor="ledger-wallet-name" className="mb-2 block text-sm">
                  Wallet name
                </label>
                <Input
                  id="ledger-wallet-name"
                  value={walletName}
                  onChange={event => {
                    walletNameEdited.current = true
                    newWalletName.current = event.target.value
                    setWalletName(event.target.value)
                  }}
                />
              </div>
            )}
            {selectedFamilies.includes('zcash') && (
              <Button variant="outline" onClick={() => void chooseBirthday()}>
                {birthdayHeight === undefined
                  ? 'Restore from sync date'
                  : `Sync from block ${birthdayHeight.toLocaleString()}`}
              </Button>
            )}
            {firstWallet && (
              <div className="space-y-3">
                <PasswordInput
                  placeholder="Password"
                  value={password}
                  onChange={setPassword}
                  error={
                    password ? (getNewPasswordValidationError(password) ?? undefined) : undefined
                  }
                />
                <PasswordStrength password={password} />
                <PasswordInput
                  placeholder="Confirm password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  error={
                    confirmPassword && password !== confirmPassword
                      ? 'Passwords do not match'
                      : undefined
                  }
                />
              </div>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
          <div className="page-footer">
            <Button
              className="w-full"
              isLoading={creating}
              disabled={
                creating ||
                !walletName.trim() ||
                (firstWallet && (!isNewPasswordValid(password) || password !== confirmPassword))
              }
              onClick={() => void create()}
            >
              {targetWalletId ? 'Add Accounts' : 'Add Wallet'}
            </Button>
          </div>
        </>
      )}
      {step === 'success' && (
        <>
          <div className="page-content flex flex-col items-center justify-center gap-4">
            <Icon icon="lucide:check-circle-2" width={40} className="text-primary" />
            <p>Ledger accounts added</p>
          </div>
          <div className="page-footer">
            <BetaInviteHardwareDoneButton />
          </div>
        </>
      )}
    </div>
  )
}
