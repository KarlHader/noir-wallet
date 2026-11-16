import {
  parseV1EncryptedCredentialEnvelope,
  type V1EncryptedCredentialEnvelope
} from './v1-credential-envelope'

export interface RetainedV1EnvelopeReplacement {
  readonly storageKey: string
  readonly source: V1EncryptedCredentialEnvelope
  readonly target: V1EncryptedCredentialEnvelope
}

export interface RetainedV1EnvelopeStorage {
  readonly read: (keys: readonly string[]) => Promise<Readonly<Record<string, unknown>>>
  readonly write: (values: Readonly<Record<string, unknown>>) => Promise<void>
}

const chromeRetainedV1EnvelopeStorage: RetainedV1EnvelopeStorage = Object.freeze({
  read: (keys: readonly string[]) => chrome.storage.local.get([...keys]),
  write: (values: Readonly<Record<string, unknown>>) => chrome.storage.local.set(values)
})

function envelopeEquals(
  left: V1EncryptedCredentialEnvelope,
  right: V1EncryptedCredentialEnvelope
): boolean {
  return (
    left.encryptedData === right.encryptedData && left.salt === right.salt && left.iv === right.iv
  )
}

function assertReplacements(replacements: readonly RetainedV1EnvelopeReplacement[]): void {
  if (replacements.length === 0) throw new Error('No retained V1 credentials to replace')
  const keys = new Set<string>()
  for (const replacement of replacements) {
    if (
      replacement.storageKey.length === 0 ||
      replacement.storageKey.trim() !== replacement.storageKey ||
      keys.has(replacement.storageKey)
    ) {
      throw new Error('Invalid retained V1 credential replacement inventory')
    }
    parseV1EncryptedCredentialEnvelope(replacement.source)
    parseV1EncryptedCredentialEnvelope(replacement.target)
    keys.add(replacement.storageKey)
  }
}

function classifyPersistedEnvelopes(
  replacements: readonly RetainedV1EnvelopeReplacement[],
  persisted: Readonly<Record<string, unknown>>
): 'source' | 'target' | 'mixed-known' {
  let sourceCount = 0
  let targetCount = 0
  for (const replacement of replacements) {
    const value = parseV1EncryptedCredentialEnvelope(persisted[replacement.storageKey])
    if (envelopeEquals(value, replacement.target)) targetCount += 1
    else if (envelopeEquals(value, replacement.source)) sourceCount += 1
    else throw new Error('Retained V1 credential changed outside the password transaction')
  }
  if (sourceCount === replacements.length) return 'source'
  if (targetCount === replacements.length) return 'target'
  return 'mixed-known'
}

function replacementRecord(
  replacements: readonly RetainedV1EnvelopeReplacement[],
  version: 'source' | 'target'
): Readonly<Record<string, V1EncryptedCredentialEnvelope>> {
  return Object.freeze(
    Object.fromEntries(
      replacements.map(replacement => [replacement.storageKey, replacement[version]])
    )
  )
}

export async function replaceRetainedV1Envelopes(
  replacements: readonly RetainedV1EnvelopeReplacement[],
  storage: RetainedV1EnvelopeStorage = chromeRetainedV1EnvelopeStorage
): Promise<'replaced' | 'already-replaced'> {
  assertReplacements(replacements)
  const keys = replacements.map(replacement => replacement.storageKey)
  const previous = await storage.read(keys)
  const previousState = classifyPersistedEnvelopes(replacements, previous)
  if (previousState === 'target') return 'already-replaced'

  try {
    await storage.write(replacementRecord(replacements, 'target'))
    if (classifyPersistedEnvelopes(replacements, await storage.read(keys)) !== 'target') {
      throw new Error('Retained V1 credential target verification failed')
    }
    return 'replaced'
  } catch {
    try {
      await storage.write(replacementRecord(replacements, 'source'))
      if (classifyPersistedEnvelopes(replacements, await storage.read(keys)) !== 'source') {
        throw new Error('Retained V1 credential rollback verification failed')
      }
    } catch {
      throw new Error('Retained V1 credential rollback verification failed')
    }
    throw new Error('Retained V1 credential replacement failed')
  }
}
