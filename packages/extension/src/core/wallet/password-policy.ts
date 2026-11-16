import { PASSWORD_POLICY } from '@/config/wallet'

export function getPasswordCharacterCount(password: string): number {
  return Array.from(password).length
}

export function getNewPasswordValidationError(password: string): string | null {
  const length = getPasswordCharacterCount(password)
  if (length < PASSWORD_POLICY.MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_POLICY.MIN_LENGTH} characters`
  }
  if (length > PASSWORD_POLICY.MAX_LENGTH) {
    return `Password must be no more than ${PASSWORD_POLICY.MAX_LENGTH} characters`
  }
  if (/^\s+$/u.test(password)) {
    return 'Password cannot contain only whitespace'
  }
  return null
}

export function isNewPasswordValid(password: string): boolean {
  return getNewPasswordValidationError(password) === null
}

export type PasswordStrength = 'Too Weak' | 'Weak' | 'Medium' | 'Strong'

export function getPasswordStrength(password: string): Readonly<{
  strength: PasswordStrength
  score: number
}> {
  let score = 0
  const passwordLength = getPasswordCharacterCount(password)
  const minLength = PASSWORD_POLICY.MIN_LENGTH
  if (passwordLength >= minLength) score++
  if (passwordLength >= minLength + 4) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) score++

  const strength: PasswordStrength =
    score <= 1 ? 'Too Weak' : score === 2 ? 'Weak' : score === 3 ? 'Medium' : 'Strong'
  return Object.freeze({ strength, score })
}

export function assertNewPassword(password: string): void {
  const error = getNewPasswordValidationError(password)
  if (error) throw new Error(error)
}
