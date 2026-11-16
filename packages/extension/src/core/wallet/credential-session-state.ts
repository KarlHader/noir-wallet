export const CREDENTIAL_SESSION_DESCRIPTOR_KEY = 'keyring_session_descriptor'

interface StorageChangeLike {
  readonly oldValue?: unknown
  readonly newValue?: unknown
}

export function didCredentialSessionEnd(
  changes: Readonly<Record<string, StorageChangeLike>>,
  areaName: string
): boolean {
  if (areaName !== 'session') return false
  const descriptor = changes[CREDENTIAL_SESSION_DESCRIPTOR_KEY]
  return descriptor?.oldValue !== undefined && descriptor.newValue === undefined
}
