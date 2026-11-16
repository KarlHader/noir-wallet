export const DEFAULT_ACCOUNT_NAME = 'Account 1'
export const MAX_ACCOUNT_NAME_CODE_POINTS = 128

const UNSAFE_DISPLAY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

export function normalizeAccountName(value: string): string {
  if (typeof value !== 'string') throw new Error('Account name must be a string')

  const normalized = value.normalize('NFC').trim()
  if (
    normalized.length === 0 ||
    [...normalized].length > MAX_ACCOUNT_NAME_CODE_POINTS ||
    UNSAFE_DISPLAY_CHARACTERS.test(normalized)
  ) {
    throw new Error(`Account name must contain 1-${MAX_ACCOUNT_NAME_CODE_POINTS} characters`)
  }
  return normalized
}

export function getAccountNameValidationError(value: string): string | null {
  try {
    normalizeAccountName(value)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid account name'
  }
}
