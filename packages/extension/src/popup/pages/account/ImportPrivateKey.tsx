import { ANALYTICS_EVENTS, sendAnalyticsEvent } from '@/lib/analytics'
import { getResponseErrorMessage } from '@/lib/errors'
import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { ChainIcon } from '../../components/common/ChainIcon'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { WarningBox } from '../../components/ui/WarningBox'
import { useNavigate } from '../../provider/Router'
import {
  detectPrivateKeyImport,
  type DetectedPrivateKeyFamily,
  type PrivateKeyImportChainFamily
} from '@/core/keyring/application/private-key-import-detection'
import { DASH_CHAIN_FEATURE_FLAG } from '@/config/multichain-feature-flags'
import { privateKeyImportFamilyOptions } from '@/popup/services/private-key-import-options'
import {
  parsePrivateKeyPreview,
  type PrivateKeyAddressPreview
} from '@/popup/services/private-key-preview'

const FAMILY_PRESENTATION = Object.freeze({
  eip155: {
    label: 'EVM',
    description: 'Ethereum and compatible networks',
    icon: 'token-branded:ethereum',
    defaultName: 'Imported EVM Wallet'
  },
  bip122: {
    label: 'Bitcoin',
    description: 'Current Bitcoin network mode',
    icon: 'token-branded:bitcoin',
    defaultName: 'Imported Bitcoin Wallet'
  },
  pearl: {
    label: 'Pearl',
    description: 'Current Pearl network mode',
    icon: 'pearl',
    iconKind: 'chain',
    defaultName: 'Imported Pearl Wallet'
  },
  solana: {
    label: 'Solana',
    description: 'Solana Devnet in Testnet Mode',
    icon: 'token-branded:solana',
    defaultName: 'Imported Solana Wallet'
  },
  near: {
    label: 'NEAR',
    description: 'NEAR Testnet in Testnet Mode',
    icon: 'token-branded:near',
    defaultName: 'Imported NEAR Wallet'
  },
  dash: {
    label: 'Dash',
    description: 'P2PKH on the current Dash network',
    icon: 'token-branded:dash',
    defaultName: 'Imported Dash Wallet'
  }
} as const satisfies Record<
  DetectedPrivateKeyFamily,
  {
    readonly label: string
    readonly description: string
    readonly icon: string
    readonly defaultName: string
    readonly iconKind?: 'chain'
  }
>)

function unknownRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) record[key] = entry
  return record
}

const DASH_IMPORT_ENABLED = __ENABLED_CHAIN_FEATURE_FLAGS__.includes(DASH_CHAIN_FEATURE_FLAG)
const FAMILY_OPTIONS = privateKeyImportFamilyOptions(__ENABLED_CHAIN_FEATURE_FLAGS__)
const AVAILABLE_FAMILIES = FAMILY_OPTIONS.filter(option => option.enabled).map(
  option => option.family
)
const AVAILABLE_FAMILY_SET = new Set<PrivateKeyImportChainFamily>(AVAILABLE_FAMILIES)
const ED25519_IMPORT_ENABLED = AVAILABLE_FAMILIES.some(
  family => family === 'solana' || family === 'near'
)
const PRIVATE_KEY_PLACEHOLDER = ED25519_IMPORT_ENABLED
  ? `Paste an ${AVAILABLE_FAMILIES.map(family => FAMILY_PRESENTATION[family].label).join(', ')} key`
  : 'Paste an EVM private key'
const PRIVATE_KEY_PROMPT = ED25519_IMPORT_ENABLED
  ? `Enter a supported ${AVAILABLE_FAMILIES.map(family => FAMILY_PRESENTATION[family].label).join(', ')} private key. `
  : 'Enter a supported EVM private key. '

export function ImportPrivateKey() {
  const { replace } = useNavigate()
  const [privateKey, setPrivateKey] = useState('')
  const [displayName, setDisplayName] = useState('Imported EVM Wallet')
  const [nameEdited, setNameEdited] = useState(false)
  const [familyOverride, setFamilyOverride] = useState<DetectedPrivateKeyFamily | null>(null)
  const [showFamilyPicker, setShowFamilyPicker] = useState(false)
  const [visible, setVisible] = useState(false)
  const [preview, setPreview] = useState<PrivateKeyAddressPreview | null>(null)
  const [dashPreviewAddress, setDashPreviewAddress] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rawDetection = useMemo(() => detectPrivateKeyImport(privateKey), [privateKey])
  const testnetWifChoice = rawDetection?.format === 'ambiguous-testnet-wif'
  const detection =
    rawDetection &&
    rawDetection.chainFamily !== null &&
    (rawDetection.chainFamily === 'dash'
      ? DASH_IMPORT_ENABLED
      : AVAILABLE_FAMILY_SET.has(rawDetection.chainFamily))
      ? rawDetection
      : null
  const chainFamily = familyOverride ?? (testnetWifChoice ? null : (detection?.chainFamily ?? null))
  const presentation = chainFamily ? FAMILY_PRESENTATION[chainFamily] : null
  const familyAllowed = (family: DetectedPrivateKeyFamily) =>
    family === 'dash'
      ? DASH_IMPORT_ENABLED
      : AVAILABLE_FAMILY_SET.has(family) || (testnetWifChoice && family === 'bip122')

  useEffect(() => {
    if (!nameEdited && presentation) setDisplayName(presentation.defaultName)
  }, [nameEdited, presentation])

  const chooseFamily = (family: DetectedPrivateKeyFamily) => {
    if (!familyAllowed(family)) return
    setFamilyOverride(family)
    setPreview(null)
    setDashPreviewAddress(null)
    setShowFamilyPicker(false)
    setError(null)
  }

  const previewKey = async () => {
    if (!chainFamily || !familyAllowed(chainFamily)) return
    setPreviewing(true)
    setError(null)
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'PREVIEW_PRIVATE_KEY_WALLET',
        privateKey: privateKey.trim(),
        chainFamily
      })
      if (
        typeof response !== 'object' ||
        response === null ||
        Array.isArray(response) ||
        (response as { success?: unknown }).success !== true
      ) {
        throw new Error(getResponseErrorMessage(response) ?? 'Private-key preview failed')
      }
      const result = unknownRecord((unknownRecord(response) ?? {}).result)
      if (chainFamily === 'dash') {
        const address = unknownRecord(
          Array.isArray(result?.addresses) && result.addresses.length === 1
            ? result.addresses[0]
            : null
        )
        if (
          result?.chainFamily !== 'dash' ||
          address?.addressScheme !== 'dash_p2pkh' ||
          typeof address.address !== 'string' ||
          address.address.length === 0
        ) {
          throw new Error('Private-key preview does not match the selected network')
        }
        setDashPreviewAddress(address.address)
        setPreview(null)
        return
      }
      const nextPreview = parsePrivateKeyPreview(result)
      if (nextPreview.chainFamily !== chainFamily) {
        throw new Error('Private-key preview does not match the selected network')
      }
      setDashPreviewAddress(null)
      setPreview(nextPreview)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Private-key preview failed')
    } finally {
      setPreviewing(false)
    }
  }

  const submit = async () => {
    if (!chainFamily || !familyAllowed(chainFamily)) return
    setSubmitting(true)
    setError(null)
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'IMPORT_PRIVATE_KEY_WALLET',
        privateKey: privateKey.trim(),
        chainFamily,
        displayName: displayName.trim()
      })
      if (
        typeof response !== 'object' ||
        response === null ||
        Array.isArray(response) ||
        (response as { success?: unknown }).success !== true
      ) {
        throw new Error(getResponseErrorMessage(response) ?? 'Private-key Wallet import failed')
      }
      const analyticsChain =
        chainFamily === 'eip155'
          ? 'evm'
          : chainFamily === 'bip122'
            ? 'bitcoin'
            : chainFamily === 'solana' || chainFamily === 'near'
              ? chainFamily
              : null
      if (analyticsChain) {
        sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
          chain: analyticsChain,
          params: { method: 'private_key' }
        })
      }
      setPrivateKey('')
      replace('/')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Private-key Wallet import failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Import private key" showBack />
      <div className="page-content space-y-5">
        <div>
          <label htmlFor="private-key-wallet-name" className="mb-2 block text-sm text-muted">
            Wallet name
          </label>
          <Input
            id="private-key-wallet-name"
            value={displayName}
            maxLength={128}
            onChange={event => {
              setDisplayName(event.target.value)
              setNameEdited(true)
            }}
            className="h-[46px] rounded-xl"
          />
        </div>

        <div>
          <label htmlFor="private-key-value" className="mb-2 block text-sm text-muted">
            Private key
          </label>
          <Input
            id="private-key-value"
            type={visible ? 'text' : 'password'}
            value={privateKey}
            maxLength={512}
            spellCheck={false}
            autoComplete="off"
            onChange={event => {
              setPrivateKey(event.target.value)
              setFamilyOverride(null)
              setShowFamilyPicker(false)
              setPreview(null)
              setDashPreviewAddress(null)
              setError(null)
            }}
            placeholder={PRIVATE_KEY_PLACEHOLDER}
            className="h-[46px] rounded-xl font-mono text-xs"
            endContent={
              <button
                type="button"
                aria-label={visible ? 'Hide private key' : 'Show private key'}
                onClick={() => setVisible(value => !value)}
                className="text-muted"
              >
                <Icon icon={visible ? 'lucide:eye-off' : 'lucide:eye'} width={18} height={18} />
              </button>
            }
          />
        </div>

        {privateKey.trim() && !preview && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/5">
                {presentation && 'iconKind' in presentation && presentation.iconKind === 'chain' ? (
                  <ChainIcon
                    chain={presentation.icon}
                    className="size-6 rounded-full"
                    showTooltip={false}
                  />
                ) : (
                  <Icon icon={presentation?.icon ?? 'lucide:circle-help'} width={24} height={24} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted">
                  {detection && !familyOverride ? 'Detected network' : 'Import as'}
                </p>
                <p className="font-medium">{presentation?.label ?? 'Network not detected'}</p>
                <p className="truncate text-xs text-muted">
                  {presentation?.description ?? 'Choose the network this key came from'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowFamilyPicker(value => !value)}
                className="text-sm font-medium text-primary"
              >
                Change
              </button>
            </div>
            {(detection?.format === 'bitcoin-wif' || detection?.format === 'ambiguous-hex') &&
              !familyOverride && (
                <p className="mt-3 text-xs leading-4 text-muted">
                  {detection.format === 'bitcoin-wif'
                    ? 'This WIF encoding is shared by Bitcoin and Pearl. Choose the network this key came from.'
                    : 'A 32-byte hex key can be used by multiple networks. Noir Wallet defaults it to EVM.'}
                </p>
              )}
            {testnetWifChoice && (
              <div className="mt-3 border-t border-border pt-3">
                <p className="text-xs leading-4 text-muted">
                  {DASH_IMPORT_ENABLED
                    ? 'This testnet WIF prefix is shared by Bitcoin and Dash. Choose Bitcoin or Dash.'
                    : 'This testnet WIF prefix is shared with Dash. This build imports it as Bitcoin.'}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(['bip122', 'dash'] as const)
                    .filter(family => family !== 'dash' || DASH_IMPORT_ENABLED)
                    .map(family => (
                      <button
                        key={family}
                        type="button"
                        onClick={() => chooseFamily(family)}
                        className={`rounded-xl border px-3 py-2.5 text-sm ${
                          chainFamily === family
                            ? 'border-primary/70 bg-primary/10'
                            : 'border-border bg-background'
                        }`}
                      >
                        {FAMILY_PRESENTATION[family].label}
                      </button>
                    ))}
                </div>
              </div>
            )}
            {showFamilyPicker && (
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
                {FAMILY_OPTIONS.map(({ family, enabled }) => (
                  <button
                    key={family}
                    type="button"
                    disabled={!enabled}
                    onClick={() => chooseFamily(family)}
                    className={`rounded-xl border px-3 py-2.5 text-sm disabled:cursor-default ${
                      chainFamily === family
                        ? 'border-primary/70 bg-primary/10'
                        : 'border-border bg-background'
                    } ${enabled ? 'disabled:opacity-50' : 'text-muted disabled:opacity-100'}`}
                  >
                    {FAMILY_PRESENTATION[family].label}
                    {!enabled && <span className="block text-[10px] text-muted">Coming soon</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {(preview || dashPreviewAddress) && (
          <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted">{presentation?.label} address preview</p>
              <button
                type="button"
                onClick={() => {
                  setPreview(null)
                  setDashPreviewAddress(null)
                  setShowFamilyPicker(true)
                }}
                className="text-sm font-medium text-primary"
              >
                Change
              </button>
            </div>
            <p className="mt-2 break-all font-mono text-sm leading-5">
              {dashPreviewAddress ??
                (
                  preview?.addresses.find(address => address.preferredForReceive) ??
                  preview?.addresses[0]
                )?.address}
            </p>
            <p className="mt-2 text-xs text-muted">
              {chainFamily === 'dash'
                ? 'P2PKH on the active Dash network'
                : preview?.chainFamily === 'eip155'
                  ? `Available on ${preview.addresses.length} EVM networks`
                  : preview?.chainFamily === 'bip122'
                    ? `Native SegWit · ${preview.addresses.length - 1} additional Bitcoin address formats`
                    : `Available on the active ${presentation?.label} network`}
            </p>
          </div>
        )}

        <WarningBox>
          {presentation
            ? `This key will be imported as ${presentation.label}. `
            : PRIVATE_KEY_PROMPT}
          It will not create a Zcash account. Anyone with the key can move its funds.
        </WarningBox>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
      <div className="page-footer">
        <Button
          className="h-[45px] w-full"
          disabled={
            !privateKey.trim() || !displayName.trim() || !chainFamily || previewing || submitting
          }
          isLoading={previewing || submitting}
          onClick={preview || dashPreviewAddress ? submit : previewKey}
        >
          {preview || dashPreviewAddress ? 'Import wallet' : 'Continue'}
        </Button>
      </div>
    </div>
  )
}
