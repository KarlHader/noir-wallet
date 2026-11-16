import { useState } from 'react'
import { Button } from '../ui/button'
import { PageHeader } from './PageHeader'
import { PasswordStrength } from './PasswordStrength'
import { PasswordInput } from './PasswordInput'
import { LabeledCheckbox } from './LabeledCheckbox'
import { PASSWORD_POLICY } from '@/config/wallet'
import { getNewPasswordValidationError, isNewPasswordValid } from '@/core/wallet/password-policy'
import { classifyError } from '@/lib/errors'
import { openModal } from '../../provider/ModalManager'
import { TermsOfUse } from '../../pages/settings/TermsOfUse'

type PasswordFormMode = 'create' | 'import' | 'change'

interface PasswordFormProps {
  mode: PasswordFormMode
  title: string
  description: string
  submitText: string
  showTerms?: boolean
  onSubmit: (data: { current?: string; new: string }) => Promise<void>
  onBack?: () => void
}

export function PasswordForm({
  mode,
  title,
  description,
  submitText,
  showTerms = false,
  onSubmit,
  onBack
}: PasswordFormProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const passwordError = password ? getNewPasswordValidationError(password) : null
  const isValid =
    isNewPasswordValid(password) &&
    password === confirmPassword &&
    (!showTerms || agreedToTerms) &&
    (mode !== 'change' || currentPassword.length > 0)

  const handleSubmit = async () => {
    if (!isValid) return

    setError(null)
    setIsSubmitting(true)

    try {
      await onSubmit({
        current: mode === 'change' ? currentPassword : undefined,
        new: password
      })
    } catch (err) {
      setError(classifyError(err).userMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title={title} showBack={!!onBack} onBack={onBack} backDisabled={isSubmitting} />

      <div className="flex-1 px-5 pt-4 overflow-y-auto">
        <p className="text-base text-muted leading-relaxed mb-6">{description}</p>

        <div className="space-y-4">
          {mode === 'change' && (
            <PasswordInput
              label="Current Password"
              value={currentPassword}
              onChange={setCurrentPassword}
              placeholder="Enter current password"
            />
          )}

          <PasswordInput
            label={mode === 'change' ? 'New Password' : 'Password'}
            value={password}
            onChange={setPassword}
            placeholder={
              mode === 'change'
                ? 'Enter new password'
                : `${PASSWORD_POLICY.MIN_LENGTH}–${PASSWORD_POLICY.MAX_LENGTH} characters`
            }
            error={passwordError ?? undefined}
          />

          <PasswordStrength password={password} />

          <PasswordInput
            label="Confirm Password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Confirm password"
            error={
              error ||
              (confirmPassword && password !== confirmPassword
                ? 'Passwords do not match'
                : undefined)
            }
          />
          <div className="text-xs text-muted">
            * Use {PASSWORD_POLICY.MIN_LENGTH}–{PASSWORD_POLICY.MAX_LENGTH} characters. Spaces and
            symbols are allowed; your password is used exactly as entered.
          </div>
        </div>
      </div>

      <div className="px-5 pb-5 space-y-4">
        {showTerms && (
          <div className="flex justify-center">
            <LabeledCheckbox
              checked={agreedToTerms}
              onChange={setAgreedToTerms}
              label={
                <span>
                  I agree to the{' '}
                  <button
                    type="button"
                    onClick={() =>
                      openModal({
                        showCloseButton: true,
                        body: () => <TermsOfUse embedded />
                      })
                    }
                    className="text-muted hover:text-foreground underline cursor-pointer"
                  >
                    Terms of Use
                  </button>
                </span>
              }
            />
          </div>
        )}
        <Button
          onClick={handleSubmit}
          disabled={!isValid || isSubmitting}
          className="w-full h-[45px]"
        >
          {isSubmitting ? 'Processing...' : submitText}
        </Button>
      </div>
    </div>
  )
}
