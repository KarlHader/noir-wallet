import { ANALYTICS_EVENTS, sendAnalyticsEvent } from '@/lib/analytics'
import { getResponseErrorMessage } from '@/lib/errors'
import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@iconify/react'
import { PageHeader } from '../../components/common/PageHeader'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { cn } from '@/lib/utils'
import { useNavigate } from '../../provider/Router'
import {
  detectPrivateKeyImport,
  type PrivateKeyImportChainFamily
} from '@/core/keyring/application/private-key-import-detection'
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
  }
} satisfies Record<PrivateKeyImportChainFamily, Record<string, string>>)

const FAMILY_OPTIONS = privateKeyImportFamilyOptions(__ENABLED_CHAIN_FEATURE_FLAGS__)
const AVAILABLE_FAMILIES = FAMILY_OPTIONS.filter(option => option.enabled).map(
  option => option.family
)
const AVAILABLE_FAMILY_SET = new Set<PrivateKeyImportChainFamily>(AVAILABLE_FAMILIES)
export function ImportPrivateKey() {
  const { replace } = useNavigate()
  const [privateKey, setPrivateKey] = useState('')
  const [displayName, setDisplayName] = useState('Imported EVM Wallet')
  const [nameEdited, setNameEdited] = useState(false)
  const [familyOverride, setFamilyOverride] = useState<PrivateKeyImportChainFamily | null>(null)
  const [showFamilyPicker, setShowFamilyPicker] = useState(false)
  const [visible, setVisible] = useState(false)
  const [preview, setPreview] = useState<PrivateKeyAddressPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const detection = useMemo(() => {
    const detected = detectPrivateKeyImport(privateKey)
    return detected && AVAILABLE_FAMILY_SET.has(detected.chainFamily) ? detected : null
  }, [privateKey])
  const chainFamily = familyOverride ?? detection?.chainFamily ?? null
  const presentation = chainFamily ? FAMILY_PRESENTATION[chainFamily] : null

  useEffect(() => {
    if (!nameEdited && presentation) setDisplayName(presentation.defaultName)
  }, [nameEdited, presentation])

  const chooseFamily = (family: PrivateKeyImportChainFamily) => {
    if (!AVAILABLE_FAMILY_SET.has(family)) return
    setFamilyOverride(family)
    setPreview(null)
    setShowFamilyPicker(false)
    setError(null)
  }

  const previewKey = async () => {
    if (!chainFamily || !AVAILABLE_FAMILY_SET.has(chainFamily)) return
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
      const nextPreview = parsePrivateKeyPreview((response as { result?: unknown }).result)
      if (nextPreview.chainFamily !== chainFamily) {
        throw new Error('Private-key preview does not match the selected network')
      }
      setPreview(nextPreview)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Private-key preview failed')
    } finally {
      setPreviewing(false)
    }
  }

  const submit = async () => {
    if (!chainFamily || !AVAILABLE_FAMILY_SET.has(chainFamily)) return
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
      sendAnalyticsEvent(ANALYTICS_EVENTS.WALLET_CREATED, {
        chain:
          chainFamily === 'eip155' ? 'evm' : chainFamily === 'bip122' ? 'bitcoin' : chainFamily,
        params: { method: 'private_key' }
      })
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
      <div className="page-content space-y-5 !pt-8">
        {!preview && (
          <div>
            <label htmlFor="private-key-value" className="mb-5 block text-sm leading-5 text-muted">
              Private key
            </label>
            <div className="relative">
              <textarea
                id="private-key-value"
                value={privateKey}
                maxLength={512}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                disabled={previewing || submitting}
                onChange={event => {
                  setPrivateKey(event.target.value)
                  setFamilyOverride(null)
                  setShowFamilyPicker(false)
                  setPreview(null)
                  setError(null)
                }}
                placeholder="Paste or type in your private key"
                className={cn(
                  'block h-[142px] w-full resize-none rounded-lg border-0 bg-popover px-3 py-3 pr-10 text-sm leading-5 placeholder:text-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  !visible && privateKey && '[-webkit-text-security:disc]'
                )}
              />
              {privateKey && (
                <button
                  type="button"
                  aria-label={visible ? 'Hide private key' : 'Show private key'}
                  onClick={() => setVisible(value => !value)}
                  className="absolute right-2 top-2 flex size-7 items-center justify-center rounded text-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  <Icon icon={visible ? 'lucide:eye-off' : 'lucide:eye'} width={18} height={18} />
                </button>
              )}
            </div>
          </div>
        )}
        {preview && (
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
        )}

        {privateKey.trim() && !preview && (
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/5">
                <Icon icon={presentation?.icon ?? 'lucide:circle-help'} width={24} height={24} />
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
            {detection?.ambiguous && !familyOverride && (
              <p className="mt-3 text-xs leading-4 text-muted">
                A 32-byte hex key can be used by multiple networks. Noir Wallet defaults it to EVM.
              </p>
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

        {preview && (
          <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted">{presentation?.label} address preview</p>
              <button
                type="button"
                onClick={() => {
                  setPreview(null)
                  setShowFamilyPicker(true)
                }}
                className="text-sm font-medium text-primary"
              >
                Change
              </button>
            </div>
            <p className="mt-2 break-all font-mono text-sm leading-5">
              {
                (
                  preview.addresses.find(address => address.preferredForReceive) ??
                  preview.addresses[0]
                ).address
              }
            </p>
            <p className="mt-2 text-xs text-muted">
              {preview.chainFamily === 'eip155'
                ? `Available on ${preview.addresses.length} EVM networks`
                : preview.chainFamily === 'bip122'
                  ? `Native SegWit · ${preview.addresses.length - 1} additional Bitcoin address formats`
                  : `Available on the active ${presentation?.label} network`}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
      <div className="page-footer">
        <Button
          size="wallet"
          className="h-[45px] w-full"
          disabled={
            !privateKey.trim() ||
            (preview !== null && !displayName.trim()) ||
            !chainFamily ||
            previewing ||
            submitting
          }
          isLoading={previewing || submitting}
          onClick={preview ? submit : previewKey}
        >
          {preview ? 'Import wallet' : 'Confirm'}
        </Button>
      </div>
    </div>
  )
}
