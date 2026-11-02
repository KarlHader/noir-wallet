import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { expect } from '@playwright/test'

const profilePath = fileURLToPath(
  new URL('../../fixtures/v1.0.30-mainnet-software-golden.json', import.meta.url)
)
const profileText = readFileSync(profilePath, 'utf8')
const profile = JSON.parse(profileText)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test.describe('frozen v1.0.30 Golden Profile', () => {
  test('pins the release provenance and complete software-wallet persistence shape', () => {
    expect(profile.source).toEqual({
      tag: 'v1.0.30',
      commit: 'a623a1c39f89b44a139ebadfcd3e3441de0b7cf9'
    })
    expect(profile.local.wallet_state).toMatchObject({
      version: 0,
      state: {
        currentWalletId: profile.expected.walletId,
        currentAccountId: profile.expected.accountId,
        currentNetwork: 'mainnet',
        wallets: [
          {
            id: profile.expected.walletId,
            seedPhraseKey: `seed_${profile.expected.walletId}`,
            accounts: [
              {
                id: profile.expected.accountId,
                derivationIndex: 0,
                birthdayHeight: profile.expected.birthdayHeight,
                addresses: profile.expected.addresses
              }
            ]
          }
        ]
      }
    })
    expect(Object.keys(profile.indexedDb).sort()).toEqual([
      'syncJournal',
      'syncJournalManifest',
      'transactions',
      'transparentTransactionCache',
      'walletData'
    ])
  })

  test('keeps the frozen encrypted credential and real WASM snapshot byte-identical', () => {
    const serializedWalletState = JSON.stringify(profile.local.wallet_state)
    expect(sha256(serializedWalletState)).toBe(
      '3f61f5f98a67c3a017c17c1acdb3ad8c5176be119241920f00336c806cd4f959'
    )

    const walletDbEntries = profile.indexedDb.walletData
    const manifest = walletDbEntries.find(
      entry => entry.key === `mainnet_${profile.expected.walletId}`
    )
    const chunk = walletDbEntries.find(
      entry => entry.key === `mainnet_${profile.expected.walletId}::c::0`
    )
    expect(manifest?.value).toMatchObject({
      metadata: { version: 1, network: 'mainnet', walletId: profile.expected.walletId },
      chunked: true,
      chunkCount: 1,
      chunkSizes: [20_449],
      totalBytes: 20_449
    })
    expect(chunk?.value?.type).toBe('bytes')
    const snapshot = Buffer.from(chunk.value.base64, 'base64')
    expect(snapshot).toHaveLength(20_449)
    expect(sha256(snapshot)).toBe(
      '8686bc54fd5504946c4a611faf25670946c236631d37ce99298234f324e0bf76'
    )
  })

  test('decrypts with the exact V1 PBKDF2/AES-GCM contract without storing plaintext', async () => {
    expect(profileText).not.toContain('abandon abandon')
    const envelope = profile.local[`seed_${profile.expected.walletId}`]
    const passwordKey = await webcrypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(profile.password),
      'PBKDF2',
      false,
      ['deriveKey']
    )
    const key = await webcrypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: Buffer.from(envelope.salt, 'base64'),
        iterations: 100_000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )
    const decrypted = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64') },
      key,
      Buffer.from(envelope.encryptedData, 'base64')
    )
    const decryptedBytes = new Uint8Array(decrypted)
    const decoded = JSON.parse(new TextDecoder().decode(decryptedBytes))
    decryptedBytes.fill(0)

    expect(decoded.seedPhrase.split(' ')).toHaveLength(24)
    expect(sha256(decoded.seedPhrase)).toBe(
      '69be79ef3c28f55d7cb84db2dd3c18dfff45eeefebd09b8c5f7f3489b8ba09ac'
    )
  })
})
