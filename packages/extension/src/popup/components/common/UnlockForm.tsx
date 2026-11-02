import { InlineError } from './InlineError'
import { useState, useEffect } from 'react'
import { Button } from '../ui/button'
import WalletIcon from '@/images/wallet-icon.svg'
import { PasswordInput } from './PasswordInput'
import { classifyError } from '@/lib/errors'
import { useNavigate } from '../../provider/Router'
import { rehydrateWalletStore } from '@/store/wallet-store'
import { openModal } from '../../provider/ModalManager'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { BlockingWalletFailure } from './BlockingWalletFailure'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { getUnlockFailureMessage } from '@/popup/services/unlock-failure-message'

interface UnlockFormProps {
  onUnlockSuccess?: () => void | Promise<void>
  activation?: {
    pending: boolean
    error: string
    onRetry: () => void
    onChangeCode: () => void
  }
  onCancel?: () => void
  showCancelButton?: boolean
  showForgotPassword?: boolean
  showWalletIcon?: boolean
  title?: string
  description?: string
  headerContent?: React.ReactNode
}

export function UnlockForm({
  onUnlockSuccess,
  activation,
  onCancel,
  showCancelButton = false,
  showForgotPassword = true,
  showWalletIcon = true,
  title = 'Enter your password',
  description,
  headerContent
}: UnlockFormProps) {
  const { replace } = useNavigate()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [lockRemainingSeconds, setLockRemainingSeconds] = useState(0)
  const [isAccountLocked, setIsAccountLocked] = useState(false)
  const [walletUpgradeFailed, setWalletUpgradeFailed] = useState(false)

  useEffect(() => {
    checkLockStatus()
  }, [])

  useEffect(() => {
    if (lockRemainingSeconds <= 0) {
      setIsAccountLocked(false)
      return
    }

    const timer = setInterval(() => {
      setLockRemainingSeconds(prev => {
        if (prev <= 1) {
          setIsAccountLocked(false)
          checkLockStatus()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [lockRemainingSeconds])

  const checkLockStatus = async () => {
    const status = await SecureStorage.getLoginAttempts()
    if (status.isLocked) {
      setIsAccountLocked(true)
      setLockRemainingSeconds(Math.ceil(status.lockRemainingMs / 1000))
    } else {
      setIsAccountLocked(false)
    }
  }

  const handleUnlock = async () => {
    if (activation?.pending || isLoading) return
    if (!password) {
      setError('Please enter your password')
      return
    }

    if (isAccountLocked) {
      setError(`Account locked. Please wait ${lockRemainingSeconds} seconds.`)
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const result = await zcashWalletRuntimeClient.unlock(password)
      if (result.upgradeFailed) {
        setWalletUpgradeFailed(true)
        return
      }
      if (result.success) {
        await rehydrateWalletStore()
        setPassword('')

        if (onUnlockSuccess) {
          await onUnlockSuccess()
        }
      } else if (result.isLocked) {
        setIsAccountLocked(true)
        setLockRemainingSeconds(Math.ceil((result.lockRemainingMs || 0) / 1000))
        setError('Too many failed attempts. Account temporarily locked.')
      } else {
        setError(getUnlockFailureMessage(result))
      }
    } catch (err) {
      setError(classifyError(err).userMessage)
    } finally {
      setIsLoading(false)
    }
  }

  const handleForgotPassword = async () => {
    const confirmed = await openModal<boolean>({
      title: 'Reset Wallet',
      body: (resolve, close) => (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm text-muted">
              If you forgot your password, you'll need to reset your wallet using your Secret
              Recovery Phrase.
            </p>
            <p className="text-sm text-muted">
              This will remove your current wallet from this device.
            </p>
          </div>

          <div className="p-3 bg-yellow-500/10 rounded-lg border border-yellow-500/20">
            <p className="text-xs text-yellow-500">
              ⚠️ Make sure you have your Secret Recovery Phrase before proceeding.
            </p>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                close()
                resolve(false)
              }}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                close()
                resolve(true)
              }}
              className="flex-1"
            >
              Reset Wallet
            </Button>
          </div>
        </div>
      )
    })

    if (confirmed) {
      setIsLoading(true)
      setError('')
      try {
        await zcashWalletRuntimeClient.reset()
        replace('/onboarding')
      } catch {
        setError('Unable to reset wallet. Please try again.')
      } finally {
        setIsLoading(false)
      }
    }
  }

  if (walletUpgradeFailed) {
    return (
      <BlockingWalletFailure
        title="Wallet upgrade failed"
        description="Noir Wallet could not finish upgrading this wallet. It will stay locked until the upgrade completes."
        assurance="Your existing wallet data is still stored on this device. Noir Wallet will not open a partially upgraded wallet."
        isRetrying={isLoading}
        onRetry={handleUnlock}
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-8">
        {headerContent}

        {showWalletIcon && !headerContent && (
          <div className="mb-6">
            <img src={WalletIcon} alt="Wallet" />
          </div>
        )}

        <h1 className="text-lg font-semibold text-center mb-2">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground text-center mb-6">{description}</p>
        )}

        <div className="w-full max-w-sm space-y-4">
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder="Enter Password"
            error={error}
            onEnter={handleUnlock}
            disabled={isAccountLocked || isLoading || activation?.pending}
          />

          {activation?.error && (
            <InlineError
              message={activation.error}
              onRetry={activation.onRetry}
              retrying={isLoading}
            />
          )}

          {isAccountLocked && lockRemainingSeconds > 0 && (
            <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/20">
              <p className="text-sm text-destructive text-center">
                🔒 Account locked. Try again in {lockRemainingSeconds}s
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="px-5 pb-5 space-y-3">
        <div className="flex gap-3">
          {showCancelButton && onCancel && (
            <Button
              variant="outline"
              onClick={onCancel}
              disabled={isLoading || activation?.pending}
              className="flex-1 h-[45px]"
            >
              Cancel
            </Button>
          )}
          {!activation?.error && (
            <Button
              onClick={handleUnlock}
              disabled={activation?.pending ? !activation.error : !password || isAccountLocked}
              isLoading={isLoading || (activation?.pending && !activation.error)}
              className={`h-[45px] ${showCancelButton ? 'flex-1' : 'w-full'}`}
            >
              {activation?.pending
                ? 'Activating wallet'
                : isAccountLocked
                  ? `Locked (${lockRemainingSeconds}s)`
                  : 'Unlock'}
            </Button>
          )}
        </div>

        {activation?.error && (
          <Button variant="ghost" className="h-10 w-full" onClick={activation.onChangeCode}>
            Use another code
          </Button>
        )}

        {showForgotPassword && (
          <button
            onClick={handleForgotPassword}
            disabled={activation?.pending}
            className="w-full text-center text-sm text-primary hover:text-primary/80 transition-colors py-2 disabled:pointer-events-none disabled:opacity-50"
          >
            Forgot password?
          </button>
        )}
      </div>
    </div>
  )
}
