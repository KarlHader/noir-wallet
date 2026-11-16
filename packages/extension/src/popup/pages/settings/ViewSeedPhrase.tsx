import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { PageHeader } from '../../components/common/PageHeader'
import { SeedPhraseDisplay } from '../../components/seed-phrase/SeedPhraseDisplay'
import { BackupWordInputs } from '../../components/seed-phrase/BackupWordInputs'
import { CopyFeedbackIcon, CopyToast, useCopyToClipboard } from '../../components/common/CopyToast'
import { useWalletBackupVerification } from '../../hooks/useWalletBackupVerification'
import { useLocation, useNavigate } from '../../provider/Router'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { getWalletsNeedingSecretPhraseBackup } from '@/core/wallet/secret-phrase-backup'
import { didCredentialSessionEnd } from '@/core/wallet/credential-session-state'
import { rehydrateWalletStore, useWalletStore } from '@/store/wallet-store'
import { classifyError } from '@/lib/errors'
import { formatWalletName } from '@/lib/format'

type BackupStep = 'password' | 'phrase' | 'confirm'

export function ViewSeedPhrase() {
  const [params] = useSearchParams()
  const walletId = params.get('walletId')
  const backupMode = params.get('backup') === '1'
  return (
    <SeedPhraseContent
      key={`${walletId ?? ''}:${backupMode}`}
      walletId={walletId}
      backupMode={backupMode}
    />
  )
}

function SeedPhraseContent({
  walletId,
  backupMode
}: {
  walletId: string | null
  backupMode: boolean
}) {
  const wallets = useWalletStore(state => state.wallets)
  const targetWalletId = useRef(walletId ?? useWalletStore.getState().currentWalletId).current
  const targetWallet = targetWalletId
    ? wallets.find(wallet => wallet.id === targetWalletId)
    : undefined
  const targetName = targetWallet ? formatWalletName(targetWallet, wallets) : ''
  const backupTarget =
    backupMode &&
    Boolean(
      walletId &&
      getWalletsNeedingSecretPhraseBackup(wallets).some(wallet => wallet.id === walletId)
    )
  const { goBack, replace } = useNavigate()
  const location = useLocation()
  const [step, setStep] = useState<BackupStep>('password')
  const [password, setPassword] = useState('')
  const [phraseWords, setPhraseWords] = useState<string[]>([])
  const [isBlurred, setIsBlurred] = useState(true)
  const [isVerifying, setIsVerifying] = useState(false)
  const [sessionEnded, setSessionEnded] = useState(false)
  const [error, setError] = useState('')
  const requestVersion = useRef(0)
  const mounted = useRef(false)
  const confirming = useRef(false)
  const verification = useWalletBackupVerification(targetWalletId)
  const { copyToClipboard, showToast, copiedKey } = useCopyToClipboard()

  const returnToPage = () => {
    if (
      location.state &&
      typeof location.state === 'object' &&
      'fromBackupBanner' in location.state
    )
      goBack()
    else if (backupMode) replace('/')
    else goBack()
  }
  const clearSecrets = () => {
    setPassword('')
    setPhraseWords([])
    setIsBlurred(true)
    setIsVerifying(false)
    verification.reset()
  }
  useEffect(() => {
    mounted.current = true
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (!didCredentialSessionEnd(changes, area)) return
      requestVersion.current += 1
      clearSecrets()
      setSessionEnded(true)
    }
    chrome.storage.onChanged.addListener(onStorageChange)
    return () => {
      mounted.current = false
      requestVersion.current += 1
      chrome.storage.onChanged.removeListener(onStorageChange)
    }
  }, [])
  useEffect(() => {
    if (!targetWallet || (backupMode && !backupTarget && !confirming.current)) {
      requestVersion.current += 1
      clearSecrets()
    }
  }, [targetWallet, backupMode, backupTarget])
  const requestIsCurrent = (version: number) =>
    mounted.current &&
    !sessionEnded &&
    requestVersion.current === version &&
    Boolean(targetWalletId && useWalletStore.getState().getWallet(targetWalletId))

  const handleUnlock = async () => {
    if (!password) {
      setError('Please enter your password')
      return
    }
    if (!targetWallet || (backupMode && !backupTarget)) return
    const version = ++requestVersion.current
    setIsVerifying(true)
    setError('')
    try {
      const phrase = await zcashWalletRuntimeClient.getSeedPhrase(
        password,
        targetWalletId ?? undefined
      )
      if (!requestIsCurrent(version)) return
      if (!phrase) throw new Error('Failed to retrieve secret phrase')
      setPassword('')
      setPhraseWords(phrase.trim().split(/\s+/))
      setStep('phrase')
    } catch (cause) {
      if (requestIsCurrent(version)) setError(classifyError(cause).userMessage)
    } finally {
      if (requestIsCurrent(version)) setIsVerifying(false)
    }
  }
  const handleBack = () => {
    requestVersion.current += 1
    clearSecrets()
    setError('')
    if (step === 'confirm') setStep('password')
    else returnToPage()
  }
  const handleContinue = async () => {
    if (!backupTarget) return
    requestVersion.current += 1
    setPhraseWords([])
    setIsBlurred(true)
    setStep('confirm')
    await verification.prepare()
  }
  const handleConfirm = async () => {
    if (!walletId || !backupTarget) return
    await verification.submit(async submitted => {
      const version = ++requestVersion.current
      confirming.current = true
      try {
        await zcashWalletRuntimeClient.confirmWalletBackup(walletId, submitted)
        if (!requestIsCurrent(version)) return
        await rehydrateWalletStore()
        if (!requestIsCurrent(version)) return
        clearSecrets()
        returnToPage()
      } finally {
        confirming.current = false
      }
    })
  }

  if (sessionEnded) return null
  const title = backupMode ? 'Back up secret phrase' : 'View secret phrase'
  if (!targetWallet || (backupMode && !backupTarget && !confirming.current)) {
    return (
      <div className="page-container">
        <PageHeader title={title} showBack onBack={returnToPage} />
        <div className="page-content text-sm text-muted">Wallet unavailable.</div>
      </div>
    )
  }
  if (step === 'password') {
    return (
      <div className="page-container">
        <PageHeader title={title} showBack onBack={handleBack} />
        <div className="page-content">
          {backupMode && <p className="mb-4 text-sm font-medium break-words">{targetName}</p>}
          <p className="mb-5 text-sm text-muted">
            Sharing your secret phrase may cause you to lose your assets
          </p>
          <label htmlFor="secret-phrase-password" className="block text-sm text-muted mb-2">
            Enter Password
          </label>
          <Input
            id="secret-phrase-password"
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            placeholder="Enter your password"
            className="h-[46px] rounded-xl mb-4"
            onKeyDown={event => event.key === 'Enter' && void handleUnlock()}
          />
          {error && (
            <p role="alert" className="text-sm text-danger mt-2">
              {error}
            </p>
          )}
        </div>
        <div className="page-footer">
          <Button
            disabled={!password}
            isLoading={isVerifying}
            onClick={handleUnlock}
            className="w-full h-[45px]"
          >
            Unlock to reveal
          </Button>
        </div>
      </div>
    )
  }
  if (step === 'confirm') {
    return (
      <div className="page-container">
        <PageHeader
          title="Confirm backup"
          showBack
          backDisabled={verification.isSubmitting}
          onBack={handleBack}
        />
        <div className="page-content">
          <p className="mb-5 text-sm font-medium break-words">{targetName}</p>
          <BackupWordInputs verification={verification} />
        </div>
        <div className="page-footer">
          <Button
            disabled={!verification.canSubmit}
            isLoading={verification.isSubmitting}
            onClick={handleConfirm}
            className="w-full h-[45px]"
          >
            Confirm backup
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="page-container">
      <CopyToast show={showToast} />
      <PageHeader title={title} showBack onBack={handleBack} />
      <div className="page-content">
        {backupMode && <p className="mb-3 text-sm font-medium break-words">{targetName}</p>}
        <p className="mb-3 text-sm text-muted">
          Never share your Secret Recovery Phrase with anyone. Anyone with this phrase can take your
          assets forever.
        </p>
        <SeedPhraseDisplay
          words={phraseWords}
          blurred={isBlurred}
          onReveal={() => setIsBlurred(false)}
        />
      </div>
      <div className="page-footer flex gap-2">
        <Button
          variant={backupMode ? 'outline' : 'default'}
          onClick={() => void copyToClipboard(phraseWords.join(' '))}
          className="h-[45px] flex-1"
        >
          <CopyFeedbackIcon copied={copiedKey === 'default'} width={16} height={16} />
          {copiedKey === 'default' ? 'Copied' : 'Copy'}
        </Button>
        {backupMode && (
          <Button onClick={handleContinue} className="h-[45px] flex-1">
            Continue
          </Button>
        )}
      </div>
    </div>
  )
}
