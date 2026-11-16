import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  CREDENTIAL_SET_SCHEMA_VERSION,
  parseCredentialEnvelopeAad,
  parseCredentialSetManifest
} from '../../../src/core/keyring/domain/index.ts'
import {
  KEYRING_MAX_UNLOCKED_CREDENTIALS,
  KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION,
  KeyringError,
  parseKeyringCommandBinding,
  parseKeyringSessionDescriptor
} from '../../../src/core/keyring/ports/index.ts'
import { STORAGE_V2_LIMITS } from '../../../src/infrastructure/persistence/schema/index.ts'

function engineMetadata(engine) {
  return {
    credentialRef: `credential:${engine}:1`,
    formatVersion: 1,
    verificationAnchorRef: `verification-anchor:${engine}:1`
  }
}

function softwareManifest(overrides = {}) {
  return {
    schemaVersion: CREDENTIAL_SET_SCHEMA_VERSION,
    credentialGenerationId: 'credential-generation:1',
    keyDomainId: 'key-domain:1',
    source: 'software',
    mnemonicWordCount: 12,
    zcashSeedPolicy: 'direct-bip39-v1',
    engines: {
      zcash: engineMetadata('zcash'),
      multichain: engineMetadata('multichain')
    },
    createdAt: 1_000,
    verifiedAt: 1_001,
    ...overrides
  }
}

function sessionDescriptor(overrides = {}) {
  return {
    schemaVersion: KEYRING_SESSION_DESCRIPTOR_SCHEMA_VERSION,
    globalUnlockEpoch: 'global-unlock:1',
    offscreenInstanceId: 'offscreen:1',
    unlockedCredentials: [
      {
        keyDomainId: 'key-domain:1',
        credentialGenerationId: 'credential-generation:1'
      },
      {
        keyDomainId: 'key-domain:2',
        credentialGenerationId: 'credential-generation:2'
      }
    ],
    startedAt: 1_000,
    lastUserActivityAt: 1_100,
    expiresAt: 2_000,
    ...overrides
  }
}

test.describe('CredentialSet and session protocol', () => {
  test('covers every KeyDomain accepted by Storage V2', () => {
    expect(KEYRING_MAX_UNLOCKED_CREDENTIALS).toBe(STORAGE_V2_LIMITS.keyDomains)
  })

  test('parses an immutable dual-engine software CredentialSet manifest', () => {
    const manifest = parseCredentialSetManifest(softwareManifest())
    const twentyFourWordManifest = parseCredentialSetManifest(
      softwareManifest({ mnemonicWordCount: 24 })
    )

    expect(manifest.source).toBe('software')
    expect(Object.keys(manifest.engines)).toEqual(['zcash', 'multichain'])
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.engines)).toBe(true)
    expect(Object.isFrozen(manifest.engines.zcash)).toBe(true)
    expect(manifest.mnemonicWordCount).toBe(12)
    expect(manifest.zcashSeedPolicy).toBe('direct-bip39-v1')
    expect(twentyFourWordManifest.mnemonicWordCount).toBe(24)
    expect(twentyFourWordManifest.zcashSeedPolicy).toBe('direct-bip39-v1')
    expect(JSON.stringify(manifest)).not.toMatch(
      /mnemonicPhrase|seedPhrase|password|privateKey|sessionId/
    )
  })

  test('allows capability-backed hardware manifests but rejects incomplete software manifests', () => {
    const hardwareManifest = softwareManifest({
      source: 'hardware',
      hardware: {
        vendor: 'keystone',
        firmwareProfile: 'cypherpunk',
        capabilities: ['zcash']
      },
      engines: { zcash: engineMetadata('zcash') }
    })
    delete hardwareManifest.mnemonicWordCount
    delete hardwareManifest.zcashSeedPolicy
    expect(() => parseCredentialSetManifest(hardwareManifest)).not.toThrow()
    expect(() =>
      parseCredentialSetManifest(
        softwareManifest({
          source: 'hardware',
          hardware: {
            vendor: 'keystone',
            firmwareProfile: 'cypherpunk',
            capabilities: ['zcash']
          },
          engines: { zcash: engineMetadata('zcash') }
        })
      )
    ).toThrow(/manifest/i)
    expect(() =>
      parseCredentialSetManifest(
        softwareManifest({
          engines: { zcash: engineMetadata('zcash') }
        })
      )
    ).toThrow(/engines/i)
    expect(() =>
      parseCredentialSetManifest({
        ...softwareManifest(),
        unexpected: true
      })
    ).toThrow(/manifest/i)
    expect(() =>
      parseCredentialSetManifest(
        softwareManifest({
          createdAt: 2_000,
          verifiedAt: 1_000
        })
      )
    ).toThrow(/precedes/i)
  })

  test('rejects legacy, missing, and unknown software seed policies', () => {
    const { mnemonicWordCount, ...missingWordCount } = softwareManifest()
    const { zcashSeedPolicy, ...missingSeedPolicy } = softwareManifest()

    expect(() => parseCredentialSetManifest({ ...softwareManifest(), schemaVersion: 1 })).toThrow(
      /manifest/i
    )
    expect(() => parseCredentialSetManifest(missingWordCount)).toThrow(/manifest/i)
    expect(() => parseCredentialSetManifest(missingSeedPolicy)).toThrow(/manifest/i)
    expect(() =>
      parseCredentialSetManifest({ ...softwareManifest(), mnemonicWordCount: 15 })
    ).toThrow(/12 or 24/i)
    expect(() =>
      parseCredentialSetManifest({ ...softwareManifest(), zcashSeedPolicy: 'bip85-v1' })
    ).toThrow(/seed policy/i)
  })

  test('freezes the exact AAD binding for a persisted engine envelope', () => {
    const aad = parseCredentialEnvelopeAad({
      schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
      engine: 'multichain',
      keyDomainId: 'key-domain:1',
      credentialGenerationId: 'credential-generation:1',
      credentialRef: 'credential:multichain:1',
      formatVersion: 1
    })

    expect(Object.isFrozen(aad)).toBe(true)
    expect(Object.keys(aad)).toEqual([
      'schemaVersion',
      'engine',
      'keyDomainId',
      'credentialGenerationId',
      'credentialRef',
      'formatVersion'
    ])
    expect(parseCredentialEnvelopeAad({ ...aad, schemaVersion: 1 }).schemaVersion).toBe(1)
    expect(() => parseCredentialEnvelopeAad({ ...aad, schemaVersion: 3 })).toThrow(/AAD/i)
    expect(() => parseCredentialEnvelopeAad({ ...aad, formatVersion: 0 })).toThrow(/version/i)
    expect(() => parseCredentialEnvelopeAad({ ...aad, ciphertext: 'not-part-of-aad' })).toThrow(
      /AAD/i
    )
  })

  test('parses a bounded immutable non-secret global session descriptor', () => {
    const descriptor = parseKeyringSessionDescriptor(sessionDescriptor())

    expect(descriptor.unlockedCredentials).toHaveLength(2)
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.unlockedCredentials)).toBe(true)
    expect(Object.isFrozen(descriptor.unlockedCredentials[0])).toBe(true)
    expect(JSON.stringify(descriptor)).not.toMatch(
      /mnemonic|password|privateKey|sessionId|credentialRef/
    )
  })

  test('allows a password-authenticated hardware-only session with no software capsules', () => {
    const descriptor = parseKeyringSessionDescriptor(sessionDescriptor({ unlockedCredentials: [] }))

    expect(descriptor.unlockedCredentials).toEqual([])
    expect(Object.isFrozen(descriptor.unlockedCredentials)).toBe(true)
  })

  test('rejects duplicate, oversized, stale, and secret-bearing session descriptors', () => {
    const duplicate = sessionDescriptor({
      unlockedCredentials: [
        {
          keyDomainId: 'key-domain:1',
          credentialGenerationId: 'credential-generation:1'
        },
        {
          keyDomainId: 'key-domain:1',
          credentialGenerationId: 'credential-generation:2'
        }
      ]
    })
    expect(() => parseKeyringSessionDescriptor(duplicate)).toThrow(KeyringError)
    expect(() =>
      parseKeyringSessionDescriptor(
        sessionDescriptor({
          unlockedCredentials: Array.from(
            { length: KEYRING_MAX_UNLOCKED_CREDENTIALS + 1 },
            (_value, index) => ({
              keyDomainId: `key-domain:${index}`,
              credentialGenerationId: `credential-generation:${index}`
            })
          )
        })
      )
    ).toThrow(KeyringError)
    expect(() =>
      parseKeyringSessionDescriptor(
        sessionDescriptor({
          lastUserActivityAt: 900
        })
      )
    ).toThrow(KeyringError)
    expect(() =>
      parseKeyringSessionDescriptor({
        ...sessionDescriptor(),
        password: 'must-not-be-persisted'
      })
    ).toThrow(KeyringError)
  })

  test('parses strict command bindings without accepting bearer-like extras', () => {
    const binding = parseKeyringCommandBinding({
      kind: 'credential',
      keyDomainId: 'key-domain:1',
      credentialGenerationId: 'credential-generation:1',
      globalUnlockEpoch: 'global-unlock:1'
    })

    expect(Object.isFrozen(binding)).toBe(true)
    expect(binding.kind).toBe('credential')
    expect(() =>
      parseKeyringCommandBinding({
        ...binding,
        sessionId: 'raw-session'
      })
    ).toThrow(KeyringError)
    expect(() =>
      parseKeyringCommandBinding({
        kind: 'global',
        globalUnlockEpoch: ' global-unlock:1'
      })
    ).toThrow(KeyringError)
  })
})
