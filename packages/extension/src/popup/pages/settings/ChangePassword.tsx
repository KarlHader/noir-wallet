import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { PasswordInput } from '../../components/common/PasswordInput'
import { PageHeader } from '../../components/common/PageHeader'
import { zcashWalletRuntimeClient } from '@/popup/services/zcash-wallet-runtime-client'
import { useNavigate } from '../../provider/Router'
import { getNewPasswordValidationError } from '@/core/wallet/password-policy'
import { classifyError } from '@/lib/errors'

export function ChangePassword() {
  const { goBack } = useNavigate()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [currentPasswordError, setCurrentPasswordError] = useState('')
  const [newPasswordError, setNewPasswordError] = useState('')
  const [confirmPasswordError, setConfirmPasswordError] = useState('')

  const handleSubmit = async () => {
    setCurrentPasswordError('')
    setNewPasswordError('')
    setConfirmPasswordError('')

    if (!currentPassword) {
      setCurrentPasswordError('Current password is required')
      return
    }
    const passwordError = getNewPasswordValidationError(newPassword)
    if (passwordError) {
      setNewPasswordError(passwordError)
      return
    }
    if (newPassword !== confirmPassword) {
      setConfirmPasswordError('New password and confirm password do not match')
      return
    }

    setIsLoading(true)
    try {
      await zcashWalletRuntimeClient.changePassword(currentPassword, newPassword)
      goBack()
    } catch (error: unknown) {
      setCurrentPasswordError(classifyError(error).userMessage)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="page-container">
      <PageHeader title="Change Password" showBack />

      <div className="flex-1 flex flex-col px-5 pt-8">
        <div className="space-y-4">
          <PasswordInput
            value={currentPassword}
            onChange={setCurrentPassword}
            placeholder="Current Password"
            error={currentPasswordError}
          />
          <PasswordInput
            value={newPassword}
            onChange={value => {
              setNewPassword(value)
              setNewPasswordError(value ? (getNewPasswordValidationError(value) ?? '') : '')
            }}
            placeholder="New Password"
            error={newPasswordError}
          />
          <PasswordInput
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Confirm New Password"
            error={confirmPasswordError}
          />
        </div>
      </div>

      <div className="px-5 pb-5">
        <Button
          onClick={handleSubmit}
          disabled={
            !currentPassword ||
            !newPassword ||
            !confirmPassword ||
            getNewPasswordValidationError(newPassword) !== null
          }
          isLoading={isLoading}
          className="w-full h-[45px]"
        >
          Change Password
        </Button>
      </div>
    </div>
  )
}
