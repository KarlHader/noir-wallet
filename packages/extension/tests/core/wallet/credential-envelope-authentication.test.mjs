import { test } from 'node:test'
import { expect } from '@playwright/test'

import { CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION } from '../../../src/core/keyring/domain/credential-set.ts'
import {
  CredentialAuthenticationError,
  authenticateHardwareCredentialEnvelope,
  authenticateSoftwareCredentialEnvelopePair,
  credentialEnvelopePairFormat,
  unwrapHardwareCredentialEnvelope,
  unwrapSoftwareCredentialEnvelopePair
} from '../../../src/infrastructure/keyring/credential-envelope-authentication.ts'

const PASSWORD = 'credential-envelope-test-password'
const TEXT_ENCODER = new TextEncoder()

function record(engine, keyDomainId, credentialRef, encryptedPayload, aadSchemaVersion = 2) {
  return {
    schemaVersion: 1,
    transactionId: `transaction:${keyDomainId}`,
    aad: {
      schemaVersion: aadSchemaVersion,
      engine,
      keyDomainId,
      credentialGenerationId: `generation:${keyDomainId}`,
      credentialRef,
      formatVersion: 1
    },
    encryptedPayload,
    createdAt: 1_000
  }
}

function rawPair(
  keyDomainId = 'wallet:1',
  aadSchemaVersion = CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION
) {
  const zcashPayload = TEXT_ENCODER.encode(
    JSON.stringify({
      encryptedData: 'AQEBAQEBAQEBAQEBAQEBAQ==',
      salt: 'AgICAgICAgICAgICAgICAg==',
      iv: 'AwMDAwMDAwMDAwMD'
    })
  )
  const multichainPayload = TEXT_ENCODER.encode(
    JSON.stringify({ schemaVersion: 1, ciphertext: 'fixture' })
  )
  return {
    zcash: record(
      'zcash',
      keyDomainId,
      `credential:${keyDomainId}:zcash`,
      zcashPayload,
      aadSchemaVersion
    ),
    multichain: record(
      'multichain',
      keyDomainId,
      `credential:${keyDomainId}:multichain`,
      multichainPayload,
      aadSchemaVersion
    )
  }
}

test.describe('Credential envelope authentication', () => {
  test('authenticates both engine payloads with their complete persistence binding', async () => {
    const raw = rawPair()
    const authenticated = await authenticateSoftwareCredentialEnvelopePair(raw, PASSWORD)
    const unwrapped = await unwrapSoftwareCredentialEnvelopePair(authenticated, PASSWORD)

    expect(credentialEnvelopePairFormat(authenticated)).toBe('authenticated')
    expect([...unwrapped.zcash]).toEqual([...raw.zcash.encryptedPayload])
    expect([...unwrapped.multichain]).toEqual([...raw.multichain.encryptedPayload])
    expect(authenticated.zcash.encryptedPayload).not.toEqual(raw.zcash.encryptedPayload)
    expect(authenticated.multichain.encryptedPayload).not.toEqual(raw.multichain.encryptedPayload)
  })

  test('rejects payload tampering, wrong passwords, and cross-Wallet copies', async () => {
    const authenticated = await authenticateSoftwareCredentialEnvelopePair(rawPair(), PASSWORD)
    const tamperedPayload = new Uint8Array(authenticated.multichain.encryptedPayload)
    tamperedPayload[tamperedPayload.length - 1] ^= 1

    await expect(
      unwrapSoftwareCredentialEnvelopePair(
        {
          ...authenticated,
          multichain: { ...authenticated.multichain, encryptedPayload: tamperedPayload }
        },
        PASSWORD
      )
    ).rejects.toThrow(/authentication/i)
    await expect(
      unwrapSoftwareCredentialEnvelopePair(authenticated, 'wrong-password')
    ).rejects.toBeInstanceOf(CredentialAuthenticationError)

    const target = rawPair('wallet:2')
    await expect(
      unwrapSoftwareCredentialEnvelopePair(
        {
          zcash: { ...target.zcash, encryptedPayload: authenticated.zcash.encryptedPayload },
          multichain: {
            ...target.multichain,
            encryptedPayload: authenticated.multichain.encryptedPayload
          }
        },
        PASSWORD
      )
    ).rejects.toThrow(/authentication/i)

    for (const pair of [
      {
        zcash: { ...authenticated.zcash, transactionId: 'transaction:substituted' },
        multichain: {
          ...authenticated.multichain,
          transactionId: 'transaction:substituted'
        }
      },
      {
        zcash: { ...authenticated.zcash, createdAt: authenticated.zcash.createdAt + 1 },
        multichain: {
          ...authenticated.multichain,
          createdAt: authenticated.multichain.createdAt + 1
        }
      },
      {
        zcash: {
          ...authenticated.zcash,
          aad: { ...authenticated.zcash.aad, formatVersion: 2 }
        },
        multichain: {
          ...authenticated.multichain,
          aad: { ...authenticated.multichain.aad, formatVersion: 2 }
        }
      }
    ]) {
      await expect(unwrapSoftwareCredentialEnvelopePair(pair, PASSWORD)).rejects.toThrow(
        /authentication/i
      )
    }
  })

  test('classifies only a complete AAD schema-1 pair as legacy', () => {
    expect(credentialEnvelopePairFormat(rawPair('wallet:legacy', 1))).toBe('legacy')
    expect(() =>
      credentialEnvelopePairFormat({
        ...rawPair('wallet:mixed', 1),
        multichain: rawPair('wallet:mixed', 2).multichain
      })
    ).toThrow(/binding/i)
    expect(() =>
      credentialEnvelopePairFormat({
        ...rawPair('wallet:transaction'),
        multichain: {
          ...rawPair('wallet:transaction').multichain,
          transactionId: 'transaction:other'
        }
      })
    ).toThrow(/binding/i)
  })
})

test.describe('Hardware credential envelope authentication', () => {
  test('authenticates one password-encrypted hardware envelope with its AAD', async () => {
    const source = rawPair().zcash
    const authenticated = await authenticateHardwareCredentialEnvelope(source, PASSWORD)

    expect(authenticated.encryptedPayload).not.toEqual(source.encryptedPayload)
    await expect(unwrapHardwareCredentialEnvelope(authenticated, PASSWORD)).resolves.toEqual(
      source.encryptedPayload
    )
  })

  test('rejects wrong passwords and AAD substitution', async () => {
    const source = rawPair().zcash
    const authenticated = await authenticateHardwareCredentialEnvelope(source, PASSWORD)

    await expect(
      unwrapHardwareCredentialEnvelope(authenticated, 'wrong-password')
    ).rejects.toBeInstanceOf(CredentialAuthenticationError)
    await expect(
      unwrapHardwareCredentialEnvelope(
        {
          ...authenticated,
          aad: { ...authenticated.aad, keyDomainId: 'wallet:substituted' }
        },
        PASSWORD
      )
    ).rejects.toThrow('Credential envelope authentication failed')
  })

  test('rejects legacy AAD instead of accepting an unbound record', async () => {
    const source = rawPair().zcash
    await expect(
      authenticateHardwareCredentialEnvelope(
        { ...source, aad: { ...source.aad, schemaVersion: 1 } },
        PASSWORD
      )
    ).rejects.toThrow('Unsupported hardware credential envelope format')
  })
})
