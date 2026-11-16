export function inviteCheckErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'This invite code has already been used.') return message
  if (message === 'Enter a valid invite code.') return message
  if (message === 'Invite request timed out. Try again.') return message
  return 'Could not check the code. Please try again.'
}

export function inviteBindingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Wallet account is not ready yet. Try again.') return message
  if (message === 'Could not activate this invite code. Try again.') return message
  if (message === 'This invite code has already been used.') return message
  if (message === 'Enter a valid invite code.') return message
  if (message === 'Invite request timed out. Try again.') return message
  return 'Could not activate this invite code. Try again.'
}
