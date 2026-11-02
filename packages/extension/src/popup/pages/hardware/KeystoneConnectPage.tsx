import { InlineError } from '@/popup/components/common/InlineError'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { PageHeader } from '../../components/common/PageHeader'
import { useNavigate } from '../../provider/Router'
import { PasswordInput } from '../../components/common/PasswordInput'
import { PasswordStrength } from '../../components/common/PasswordStrength'
import { QRScanner } from '../../components/hardware/QRScanner'
import { SyncOptionsModal } from '../../components/onboarding/SyncOptionsModal'
import { ChainIcon } from '../../components/common/ChainIcon'
import { openModal } from '../../provider/ModalManager'
import {
  parseKeystoneConnectionAccount,
  projectKeystoneBitcoinAccounts,
  projectKeystoneMultiCoinAccounts,
  resolveKeystoneSetupPlan,
  type KeystoneConnectionAccount,
  type KeystoneChainSelection,
  type UR
} from '@/lib/keystone'
import {
  createBitcoinHardwareCredential,
  createMultiAccountsHardwareCredential,
  createZcashHardwareCredential
} from '@/core/wallet/hardware-wallet-data'
import { useWalletStore } from '@/store/wallet-store'
import { nextHardwareWalletName } from '@/lib/hardware-connect-options'
import { PASSWORD_POLICY } from '@/config/wallet'
import { getNewPasswordValidationError, isNewPasswordValid } from '@/core/wallet/password-policy'
import { formatSortAddress } from '@/lib/format'
import { ANALYTICS_EVENTS, PAGE_IDS, sendAnalyticsEvent } from '@/lib/analytics'
import keystoneLogo from '@/images/keystone-logo.webp'
import { classifyError } from '@/lib/errors'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { accountNetworksClient } from '../../services/account-networks-client'
import { keystoneHardwareProvisioningClient } from '../../services/hardware-provisioning-client'
import { BetaInviteHardwareDoneButton } from '../../components/onboarding/BetaInviteBinding'
import {
  buildKeystoneNetworkBundles,
  filterKeystoneMultiAccountsPayload,
  type KeystoneNetworkBundle
} from './keystone-chain-selection'

type Step = 'networks' | 'guide' | 'scan' | 'configure' | 'success'

const chainLabels = Object.freeze({
  zcash: 'ZEC',
  bitcoin: 'BTC',
  evm: 'EVM',
  solana: 'SOL',
  tron: 'TRON',
  near: 'NEAR'
}) satisfies Readonly<Record<KeystoneChainSelection, string>>

const chainIconAliases = Object.freeze({
  zcash: 'zcash',
  bitcoin: 'bitcoin',
  evm: 'ethereum',
  solana: 'solana',
  tron: 'tron',
  near: 'near'
}) satisfies Readonly<Record<KeystoneChainSelection, string>>

const networkBundles = buildKeystoneNetworkBundles(__ENABLED_CHAIN_FEATURE_FLAGS__)

/** Full-tab Keystone firmware selection and account connection flow. */
export function KeystoneConnectPage() {
  const { replace } = useNavigate()
  const [step, setStep] = useState<Step>('networks')
  const [selectedBundleId, setSelectedBundleId] = useState<KeystoneNetworkBundle['id'] | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scannerKey, setScannerKey] = useState(0)
  const [connection, setConnection] = useState<KeystoneConnectionAccount | null>(null)
  const [accountIndex, setAccountIndex] = useState(0)

  const [walletName, setWalletName] = useState('Keystone Wallet 1')
  const walletNameEdited = useRef(false)
  const [birthdayHeight, setBirthdayHeight] = useState<number | undefined>(undefined)
  const [isExistingWallet, setIsExistingWallet] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const retainedV1WalletCount = useWalletStore(state => state.wallets.length)
  const [hasStorageV2Wallet, setHasStorageV2Wallet] = useState(false)
  const [walletInventoryLoading, setWalletInventoryLoading] = useState(true)
  const [walletInventoryError, setWalletInventoryError] = useState(false)
  const walletInventoryRequest = useRef(0)
  const isFirstWallet =
    !walletInventoryLoading &&
    !walletInventoryError &&
    retainedV1WalletCount === 0 &&
    !hasStorageV2Wallet
  const selectedBundle = networkBundles.find(bundle => bundle.id === selectedBundleId)
  const setupPlan = resolveKeystoneSetupPlan(
    selectedBundle && !selectedBundle.disabled ? selectedBundle.requestedNetworks : []
  )
  const selectedFirmwareProfile =
    setupPlan.status === 'compatible' ? setupPlan.firmwareProfile : null
  const guideDescription =
    selectedFirmwareProfile === 'multi-coin'
      ? "Use Multi-Coin firmware, then scan your Keystone's account connection QR."
      : selectedFirmwareProfile === 'bitcoin-only'
        ? "Use Bitcoin-Only firmware, then scan your Keystone's Bitcoin account QR."
        : "Use Cypherpunk firmware, then scan your Keystone's Zcash connection QR."
  const firstGuideStep =
    selectedFirmwareProfile === 'multi-coin'
      ? 'Unlock your Keystone with Multi-Coin firmware'
      : selectedFirmwareProfile === 'bitcoin-only'
        ? 'Unlock your Keystone with Bitcoin-Only firmware'
        : 'Unlock your Keystone with Cypherpunk firmware'
  const finalGuideStep =
    selectedFirmwareProfile === 'multi-coin'
      ? 'Show the software wallet connection QR and scan it'
      : selectedFirmwareProfile === 'bitcoin-only'
        ? 'Select Bitcoin and scan its account QR code'
        : 'Select Zcash and scan its QR code'
  const scanDescription =
    selectedFirmwareProfile === 'cypherpunk'
      ? 'Point the camera at the Zcash connection QR on your Keystone screen.'
      : 'Point the camera at the account connection QR on your Keystone screen.'

  const loadWalletInventory = useCallback(async () => {
    const request = ++walletInventoryRequest.current
    setWalletInventoryLoading(true)
    setWalletInventoryError(false)
    try {
      const catalog = await accountNetworksClient.getCatalog()
      if (request !== walletInventoryRequest.current) return
      setHasStorageV2Wallet((catalog?.accounts.length ?? 0) > 0)
      if (catalog && !walletNameEdited.current)
        setWalletName(nextHardwareWalletName('keystone', catalog.accounts))
    } catch {
      if (request !== walletInventoryRequest.current) return
      setWalletInventoryError(true)
    } finally {
      if (request === walletInventoryRequest.current) setWalletInventoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadWalletInventory()
    return () => {
      walletInventoryRequest.current += 1
    }
  }, [loadWalletInventory])

  const projectedAccounts = useMemo(() => {
    if (!connection || connection.firmwareProfile === 'cypherpunk') return []
    return connection.firmwareProfile === 'multi-coin'
      ? projectKeystoneMultiCoinAccounts(
          filterKeystoneMultiAccountsPayload(
            connection.accountExport,
            selectedBundle?.requestedNetworks ?? []
          ),
          DEFAULT_NETWORK
        )
      : projectKeystoneBitcoinAccounts(connection.accountExport, DEFAULT_NETWORK)
  }, [connection, selectedBundle])
  const projectedAccountIndexes = useMemo(
    () =>
      [...new Set(projectedAccounts.map(account => account.accountIndex))].sort((a, b) => a - b),
    [projectedAccounts]
  )

  const handleBack = () => {
    if (step === 'configure') setStep('scan')
    else if (step === 'scan') setStep('guide')
    else if (step === 'guide') setStep('networks')
    else if (step === 'networks') replace('/hardware/connect')
  }

  const handleScan = (ur: UR) => {
    try {
      if (!selectedFirmwareProfile) throw new Error('Select a Keystone setup first')
      const parsed = parseKeystoneConnectionAccount(selectedFirmwareProfile, ur)
      setConnection(parsed)
      setAccountIndex(0)
      setScanError(null)
      setStep('configure')
    } catch (e) {
      setScanError(classifyError(e).userMessage)
      setScannerKey(k => k + 1)
    }
  }

  const handlePickBirthday = async () => {
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
    if (result?.confirmed) {
      setIsExistingWallet(true)
      setBirthdayHeight(result.height)
    }
  }

  const passwordError = password ? getNewPasswordValidationError(password) : null
  const passwordValid =
    !isFirstWallet || (isNewPasswordValid(password) && password === confirmPassword)
  const canCreate =
    !!connection &&
    (connection.firmwareProfile === 'cypherpunk' || projectedAccounts.length > 0) &&
    !walletInventoryLoading &&
    !walletInventoryError &&
    walletName.trim().length > 0 &&
    passwordValid &&
    !isCreating

  const handleCreate = async () => {
    if (!connection || !canCreate) return

    setIsCreating(true)
    setCreateError(null)
    try {
      if (connection.firmwareProfile === 'cypherpunk') {
        const account = connection.accountExport.accounts[accountIndex]
        await keystoneHardwareProvisioningClient.provision({
          credential: createZcashHardwareCredential({
            ufvk: account.ufvk,
            seedFingerprintHex: connection.accountExport.seedFingerprintHex,
            accountHdIndex: account.index
          }),
          displayName: walletName.trim(),
          ...(birthdayHeight === undefined ? {} : { birthdayHeight }),
          ...(isFirstWallet ? { password } : {})
        })
      } else {
        const credential =
          connection.firmwareProfile === 'multi-coin'
            ? createMultiAccountsHardwareCredential(
                filterKeystoneMultiAccountsPayload(
                  connection.accountExport,
                  selectedBundle?.requestedNetworks ?? []
                )
              )
            : createBitcoinHardwareCredential(connection.accountExport, connection.firmwareProfile)
        await keystoneHardwareProvisioningClient.provision({
          credential,
          displayName: walletName.trim(),
          ...(isFirstWallet ? { password } : {})
        })
      }
      sendAnalyticsEvent(ANALYTICS_EVENTS.HW_CONNECTED, {
        pageId: PAGE_IDS.HARDWARE_CONNECT,
        extra: { is_existing_wallet: isExistingWallet, hardware: 'keystone' }
      })
      sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
        pageId: PAGE_IDS.HARDWARE_CONNECT,
        params: { method: 'hardware' },
        extra: { hardware: 'keystone' }
      })
      setStep('success')
    } catch (e) {
      setCreateError(classifyError(e).userMessage)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="page-container page-container--tab">
      <PageHeader
        title={
          step === 'networks'
            ? 'Choose your networks'
            : step === 'guide'
              ? 'Connect Hardware Wallet'
              : 'Connect Keystone'
        }
        showBack={step !== 'success'}
        onBack={handleBack}
      />

      {step === 'networks' && (
        <>
          <div className="page-content">
            <img src={keystoneLogo} alt="Keystone" className="h-7 w-auto mt-1 mb-5" />

            <div className="space-y-2" role="radiogroup" aria-label="Keystone networks">
              {networkBundles.map(bundle => (
                <KeystoneNetworkBundleCard
                  key={bundle.id}
                  bundle={bundle}
                  selected={selectedBundleId === bundle.id}
                  onSelect={() => setSelectedBundleId(bundle.id)}
                />
              ))}
            </div>
          </div>

          <div className="page-footer">
            <Button
              onClick={() => setStep('guide')}
              disabled={setupPlan.status !== 'compatible'}
              className="w-full h-[45px]"
            >
              Continue
            </Button>
          </div>
        </>
      )}

      {step === 'guide' && (
        <>
          <div className="page-content">
            <img src={keystoneLogo} alt="Keystone" className="h-7 w-auto mt-2 mb-8" />

            <p className="text-sm text-muted mb-8">{guideDescription}</p>

            <p className="text-sm font-semibold mb-4">Instructions</p>
            <div className="space-y-3">
              <GuideStep icon="lucide:lock" text={firstGuideStep} />
              <GuideStep icon="lucide:menu" text="Tap the menu icon" />
              <GuideStep icon="lucide:link-2" text="Tap on Connect Software Wallet" />
              <GuideStep icon="lucide:scan-line" text={finalGuideStep} />
            </div>
          </div>
          <div className="page-footer">
            <Button onClick={() => setStep('scan')} className="w-full h-[45px]">
              <Icon icon="lucide:camera" width={16} height={16} className="mr-2" />
              Ready to Scan
            </Button>
          </div>
        </>
      )}

      {step === 'scan' && (
        <div className="page-content">
          <p className="text-sm text-muted text-center mb-4">{scanDescription}</p>
          <QRScanner key={scannerKey} onScan={handleScan} />
          {scanError && <p className="text-xs text-danger text-center mt-3">{scanError}</p>}
        </div>
      )}

      {step === 'configure' && connection && (
        <>
          <div className="page-content">
            <div className="flex items-center gap-3 p-4 bg-card rounded-xl mb-5">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Icon icon="lucide:check-circle" width={20} height={20} className="text-primary" />
              </div>
              <div className="min-w-0">
                <p className="font-medium text-sm">Keystone Detected</p>
                <p className="text-xs text-muted truncate">
                  Device fingerprint:{' '}
                  {formatSortAddress(
                    connection.firmwareProfile === 'cypherpunk'
                      ? connection.accountExport.seedFingerprintHex
                      : connection.accountExport.masterFingerprintHex
                  )}
                </p>
              </div>
            </div>

            {connection.firmwareProfile === 'cypherpunk' &&
              connection.accountExport.accounts.length > 1 && (
                <div className="mb-5">
                  <label className="block text-sm text-muted mb-2">Account</label>
                  <div className="space-y-2">
                    {connection.accountExport.accounts.map((account, i) => (
                      <button
                        key={account.index}
                        onClick={() => setAccountIndex(i)}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-colors ${
                          i === accountIndex
                            ? 'border-primary bg-primary/5'
                            : 'border-border bg-card hover:border-muted'
                        }`}
                      >
                        <span className="text-sm">
                          {account.name || `Account ${account.index}`}
                        </span>
                        <span className="text-xs text-muted font-mono">
                          {formatSortAddress(account.ufvk)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

            {connection.firmwareProfile !== 'cypherpunk' && (
              <div className="mb-5 rounded-xl border border-border bg-card/40 p-3">
                <p className="text-sm font-medium">
                  {projectedAccountIndexes.length} account
                  {projectedAccountIndexes.length === 1 ? '' : 's'} detected
                </p>
                <p className="mt-1 text-xs text-muted">
                  {Array.from(
                    new Set(projectedAccounts.map(account => chainLabels[account.family]))
                  ).join(', ')}
                </p>
              </div>
            )}

            <div className="mb-5">
              <label className="block text-sm text-muted mb-2">Wallet Name</label>
              <Input
                value={walletName}
                onChange={e => {
                  walletNameEdited.current = true
                  setWalletName(e.target.value)
                }}
                placeholder="Keystone Wallet 1"
                className="h-[45px]"
              />
            </div>

            {connection.firmwareProfile === 'cypherpunk' && (
              <div className="mb-5">
                <label className="block text-sm text-muted mb-2">Wallet History</label>
                <div className="space-y-2">
                  <OptionCard
                    selected={!isExistingWallet}
                    title="Brand new wallet"
                    description="No previous transactions — sync from the current block"
                    onClick={() => {
                      setIsExistingWallet(false)
                      setBirthdayHeight(undefined)
                    }}
                  />
                  <OptionCard
                    selected={isExistingWallet}
                    title="Existing wallet with funds"
                    description={
                      isExistingWallet && birthdayHeight
                        ? `Sync from block ${birthdayHeight.toLocaleString()}`
                        : 'Pick the wallet creation date to scan past transactions'
                    }
                    onClick={handlePickBirthday}
                  />
                </div>
              </div>
            )}

            {isFirstWallet && (
              <div className="space-y-4 mb-5">
                <p className="text-sm text-muted">
                  Set a password to secure your wallet on this device.
                </p>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  placeholder={`${PASSWORD_POLICY.MIN_LENGTH}–${PASSWORD_POLICY.MAX_LENGTH} characters`}
                  error={passwordError ?? undefined}
                />
                <PasswordStrength password={password} />
                <PasswordInput
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Confirm password"
                  error={
                    confirmPassword && password !== confirmPassword
                      ? 'Passwords do not match'
                      : undefined
                  }
                />
              </div>
            )}

            {walletInventoryError && (
              <InlineError
                className="mb-5"
                message="Unable to verify existing wallets"
                onRetry={() => void loadWalletInventory()}
              />
            )}

            {createError && (
              <div className="p-3 rounded-lg bg-danger/10 text-danger text-sm">{createError}</div>
            )}
          </div>

          <div className="page-footer">
            <Button
              onClick={handleCreate}
              disabled={!canCreate}
              isLoading={isCreating}
              className="w-full h-[45px]"
            >
              {isCreating ? 'Creating Wallet...' : 'Connect Wallet'}
            </Button>
          </div>
        </>
      )}

      {step === 'success' && (
        <>
          <div className="page-content flex flex-col items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
              <Icon icon="lucide:check" width={40} height={40} className="text-primary" />
            </div>
            <h2 className="text-base font-semibold mb-2">Keystone Connected</h2>
            <p className="text-sm text-muted text-center">
              Your hardware wallet is ready. Close this page and open Noir Wallet from the browser
              toolbar.
            </p>
          </div>
          <div className="page-footer">
            <BetaInviteHardwareDoneButton />
          </div>
        </>
      )}
    </div>
  )
}

function KeystoneNetworkBundleCard({
  bundle,
  selected,
  onSelect
}: {
  bundle: KeystoneNetworkBundle
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      onClick={onSelect}
      disabled={bundle.disabled}
      aria-label={bundle.disabled ? `${bundle.name}, Coming soon` : bundle.name}
      aria-checked={selected}
      className={`flex min-h-[86px] w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-default disabled:opacity-100 disabled:text-muted disabled:hover:border-border ${
        selected ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-white/20'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{bundle.name}</p>
        <p className="mt-0.5 text-xs text-muted">{bundle.firmwareDescription}</p>
        {bundle.disabled ? (
          <p className="mt-1 text-xs text-muted">Coming soon</p>
        ) : (
          <>
            <p className="mt-0.5 text-[11px] text-muted/80">
              {bundle.requestedNetworks.map(chain => chainLabels[chain]).join(', ')}
            </p>
            <div className="mt-2 flex items-center gap-3">
              <ChainIconStack chains={bundle.requestedNetworks} />
            </div>
            {bundle.comingSoonNetworks.length > 0 && (
              <p className="mt-2 text-[11px] text-muted/70">
                {bundle.comingSoonNetworks.map(chain => chainLabels[chain]).join(', ')} · Coming
                soon
              </p>
            )}
          </>
        )}
      </div>
      <div
        className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
          selected ? 'border-primary bg-primary text-background' : 'border-white/20'
        }`}
        aria-hidden="true"
      >
        {selected && <Icon icon="lucide:check" width={13} height={13} />}
      </div>
    </button>
  )
}

function ChainIconStack({ chains }: { chains: readonly KeystoneChainSelection[] }) {
  const visibleChains = chains.slice(0, 4)
  const remaining = Math.max(0, chains.length - visibleChains.length)

  return (
    <div
      className="flex items-center -space-x-2"
      aria-label={`${chains.length} supported networks`}
    >
      {visibleChains.map(chain => (
        <ChainIcon
          key={chain}
          chain={chainIconAliases[chain]}
          showTooltip={false}
          className="size-7 rounded-full border-2 border-card bg-card"
        />
      ))}
      {remaining > 0 && (
        <span
          className="flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-card bg-accent px-1.5 text-[9px] font-medium text-foreground"
          aria-label={`${remaining} additional supported network${remaining === 1 ? '' : 's'}`}
        >
          +{remaining}
        </span>
      )}
    </div>
  )
}

function GuideStep({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
        <Icon icon={icon} width={18} height={18} className="text-foreground" />
      </div>
      <p className="text-sm font-medium">{text}</p>
    </div>
  )
}

function OptionCard({
  selected,
  title,
  description,
  onClick
}: {
  selected: boolean
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-muted'
      }`}
    >
      <div
        className={`w-4 h-4 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
          selected ? 'border-primary' : 'border-muted'
        }`}
      >
        {selected && <div className="w-2 h-2 rounded-full bg-primary" />}
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
    </button>
  )
}
