import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { base64ToBytes, bytesToBase64 } from '../../../src/lib/bytes'
import { buildRoster } from '../../../src/core/multisig/roster'
import {
  isVaultGroupId,
  isVaultWalletId,
  effectiveSigningRoster,
  openVaultRecord,
  parseSealedVaultRecord,
  sealVaultRecord,
  sealedVaultRecordEquals,
  type SealedVaultRecord,
  type VaultRecordHeader
} from '../../../src/core/multisig/vault-record'

const vector = JSON.parse(
  await readFile(new URL('./fixtures/vault-record-v1.json', import.meta.url), 'utf8')
) as {
  mnemonic: string
  header: VaultRecordHeader
  share: string
  record: SealedVaultRecord
  mismatchedRecord: SealedVaultRecord
}

const MNEMONIC = vector.mnemonic
const HEADER = vector.header
const SHARE = base64ToBytes(vector.share)
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const CANNOT_OPEN = 'Vault record cannot be opened'

function flipByte(base64: string): string {
  const bytes = base64ToBytes(base64)
  bytes[0] ^= 0xff
  return bytesToBase64(bytes)
}

test.describe('multisig vault record', () => {
  test('a restored 2-of-2 phone changes the signing roster while preserving DKG evidence', async () => {
    const original = buildRoster({
      groupId: HEADER.groupId,
      threshold: 2,
      identities: new Map([
        [0, bytesToBase64(Uint8Array.of(1, ...new Uint8Array(64).fill(1)))],
        [1, bytesToBase64(Uint8Array.of(1, ...new Uint8Array(64).fill(2)))]
      ])
    })
    const restoredIdentity = bytesToBase64(Uint8Array.of(1, ...new Uint8Array(64).fill(3)))
    const header = {
      ...HEADER,
      version: 2 as const,
      participants: 2 as const,
      threshold: 2 as const,
      accountId: 'account-1',
      ownerWalletId: 'wallet-1',
      birthdayHeight: 123,
      rosterVersion: 1 as const,
      roster: original,
      recoveredPhoneIdentityPublicKey: restoredIdentity
    }
    const sealed = await sealVaultRecord(header, SHARE, MNEMONIC)
    const opened = await openVaultRecord(sealed, MNEMONIC)
    expect(opened.header).toEqual(header)
    if (opened.header.version !== 2) throw new Error('Expected v2 record')
    const effective = effectiveSigningRoster(opened.header)
    expect(opened.header.roster.rosterHash).toBe(original.rosterHash)
    expect(effective.rosterHash).not.toBe(original.rosterHash)
    expect(effective.participants[1].identityPublicKey).toBe(restoredIdentity)
    expect(effective.participants[0]).toEqual(original.participants[0])
    opened.share.fill(0)
    await expect(
      sealVaultRecord(
        { ...header, recoveredPhoneIdentityPublicKey: original.participants[0].identityPublicKey },
        SHARE,
        MNEMONIC
      )
    ).rejects.toThrow('Invalid vault record')
  })

  test('v2 authenticates ownership and immutable roster, while legacy stays readable only', async () => {
    const roster = buildRoster({
      groupId: HEADER.groupId,
      threshold: HEADER.threshold,
      identities: new Map(
        Array.from({ length: HEADER.participants }, (_, slot) => [
          slot,
          bytesToBase64(Uint8Array.from([1, ...new Uint8Array(64).fill(slot + 1)]))
        ])
      )
    })
    const header = {
      ...HEADER,
      version: 2 as const,
      accountId: 'account-1',
      ownerWalletId: 'wallet-1',
      birthdayHeight: 123,
      rosterVersion: 1 as const,
      roster
    }
    const scope = {
      accountId: header.accountId,
      ownerWalletId: header.ownerWalletId,
      groupId: header.groupId,
      network: header.network
    }
    const sealed = await sealVaultRecord(header, SHARE, MNEMONIC)
    expect(sealed.version).toBe(2)
    expect((await openVaultRecord(sealed, MNEMONIC, scope)).header).toEqual(header)
    for (const patch of [
      { accountId: 'other' },
      { ownerWalletId: 'other' },
      { groupId: 'other' },
      { network: HEADER.network === 'mainnet' ? 'testnet' : 'mainnet' }
    ]) {
      await expect(openVaultRecord({ ...sealed, ...patch }, MNEMONIC)).rejects.toThrow(CANNOT_OPEN)
      await expect(openVaultRecord(sealed, MNEMONIC, { ...scope, ...patch })).rejects.toThrow(
        CANNOT_OPEN
      )
    }
    await expect(openVaultRecord(vector.record, MNEMONIC, scope)).rejects.toThrow(CANNOT_OPEN)
    for (const patch of [
      { salt: flipByte(sealed.salt) },
      { iv: flipByte(sealed.iv) },
      { ciphertext: flipByte(sealed.ciphertext) },
      { roster },
      { version: 1 }
    ]) {
      await expect(openVaultRecord({ ...sealed, ...patch }, MNEMONIC)).rejects.toThrow(CANNOT_OPEN)
    }
    // A v1 ciphertext cannot be promoted by attaching account ownership and a new version.
    await expect(
      openVaultRecord(
        {
          ...vector.record,
          version: 2,
          accountId: scope.accountId,
          ownerWalletId: scope.ownerWalletId
        },
        MNEMONIC
      )
    ).rejects.toThrow(CANNOT_OPEN)
    expect(parseSealedVaultRecord(JSON.parse(JSON.stringify(sealed)))).toEqual(sealed)
    expect(sealedVaultRecordEquals(sealed, { ...sealed, ownerWalletId: 'other' })).toBe(false)
    expect(sealedVaultRecordEquals(sealed, { ...sealed, accountId: 'other' })).toBe(false)
    for (const birthdayHeight of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER]) {
      await expect(sealVaultRecord({ ...header, birthdayHeight }, SHARE, MNEMONIC)).rejects.toThrow(
        'Invalid vault record'
      )
    }
    const foreignRoster = buildRoster({
      groupId: 'foreign-group',
      threshold: header.threshold,
      identities: new Map(roster.participants.map(p => [p.slot, p.identityPublicKey]))
    })
    await expect(
      sealVaultRecord({ ...header, roster: foreignRoster }, SHARE, MNEMONIC)
    ).rejects.toThrow('Invalid vault record')
    await expect(
      sealVaultRecord(
        { ...header, roster: { ...roster, rosterHash: '0'.repeat(64) } },
        SHARE,
        MNEMONIC
      )
    ).rejects.toThrow('Invalid vault record')
    const duplicate = buildRoster({
      groupId: HEADER.groupId,
      threshold: HEADER.threshold,
      identities: new Map(
        roster.participants.map(p => [p.slot, roster.participants[0].identityPublicKey])
      )
    })
    await expect(
      sealVaultRecord({ ...header, roster: duplicate }, SHARE, MNEMONIC)
    ).rejects.toThrow('Invalid vault record')
  })
  test('opens the independently computed v1 vector', async () => {
    const opened = await openVaultRecord(vector.record, vector.mnemonic)
    expect(opened.header).toEqual(vector.header)
    expect(bytesToBase64(opened.share)).toBe(vector.share)
  })

  test('stray whitespace in the stored mnemonic derives the same key as the canonical phrase', async () => {
    const words = MNEMONIC.split(' ')
    const untidy = ` ${words.slice(0, 3).join('  ')}\t${words.slice(3).join(' ')}  `
    expect(untidy).not.toBe(MNEMONIC)
    const opened = await openVaultRecord(vector.record, untidy)
    expect(opened.header).toEqual(vector.header)
    expect(bytesToBase64(opened.share)).toBe(vector.share)

    const sealed = await sealVaultRecord(HEADER, SHARE, untidy)
    const reopened = await openVaultRecord(sealed, MNEMONIC)
    expect(reopened.header).toEqual(HEADER)
    expect([...reopened.share]).toEqual([...SHARE])
  })

  test('refuses a header that names another group than its entry', async () => {
    await expect(openVaultRecord(vector.mismatchedRecord, vector.mnemonic)).rejects.toThrow(
      CANNOT_OPEN
    )
  })

  test('seals and opens a record', async () => {
    const record = await sealVaultRecord(HEADER, SHARE, MNEMONIC)
    expect(record).toMatchObject({ version: 1, network: HEADER.network, groupId: HEADER.groupId })
    expect(base64ToBytes(record.salt)).toHaveLength(32)
    expect(base64ToBytes(record.iv)).toHaveLength(12)
    expect(parseSealedVaultRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    const opened = await openVaultRecord(record, MNEMONIC)
    expect(opened.header).toEqual(HEADER)
    expect([...opened.share]).toEqual([...SHARE])
  })

  test('two seals of the same input share no salt, iv or ciphertext', async () => {
    const a = await sealVaultRecord(HEADER, SHARE, MNEMONIC)
    const b = await sealVaultRecord(HEADER, SHARE, MNEMONIC)
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(sealedVaultRecordEquals(a, b)).toBe(false)
    expect(sealedVaultRecordEquals(a, { ...a })).toBe(true)
  })

  test('refuses another mnemonic and any changed field', async () => {
    const record = await sealVaultRecord(HEADER, SHARE, MNEMONIC)
    const variants: Array<[string, SealedVaultRecord, string]> = [
      ['other mnemonic', record, OTHER_MNEMONIC],
      ['network', { ...record, network: 'mainnet' }, MNEMONIC],
      ['groupId', { ...record, groupId: 'other-group' }, MNEMONIC],
      ['salt', { ...record, salt: flipByte(record.salt) }, MNEMONIC],
      ['iv', { ...record, iv: flipByte(record.iv) }, MNEMONIC],
      ['ciphertext', { ...record, ciphertext: flipByte(record.ciphertext) }, MNEMONIC]
    ]
    for (const [label, entry, mnemonic] of variants) {
      await expect(openVaultRecord(entry, mnemonic), label).rejects.toThrow(CANNOT_OPEN)
    }
  })

  test('composed and decomposed forms of a mnemonic open the same record', async () => {
    const composed = 'caf\u00e9 abandon'
    const decomposed = 'cafe\u0301 abandon'
    expect(composed).not.toBe(decomposed)
    const record = await sealVaultRecord(HEADER, SHARE, composed)
    const opened = await openVaultRecord(record, decomposed)
    expect(opened.header).toEqual(HEADER)
    const reopened = await openVaultRecord(record, composed)
    expect(reopened.header).toEqual(HEADER)
  })

  test('rejects malformed entries', () => {
    const good = vector.record
    const bad: unknown[] = [
      null,
      [],
      { ...good, extra: 1 },
      { ...good, version: 2 },
      { ...good, network: 'regtest' },
      { ...good, groupId: 'a b' },
      { ...good, salt: bytesToBase64(new Uint8Array(31)) },
      { ...good, iv: bytesToBase64(new Uint8Array(11)) },
      { ...good, ciphertext: bytesToBase64(new Uint8Array(16)) },
      (({ iv: _iv, ...rest }) => rest)(good)
    ]
    for (const value of bad) {
      expect(parseSealedVaultRecord(value)).toBeNull()
    }
    expect(parseSealedVaultRecord(good)).toEqual(good)
  })

  test('rejects a malformed header or share on seal', async () => {
    const cases: Array<[VaultRecordHeader, Uint8Array]> = [
      [{ ...HEADER, fvk: bytesToBase64(new Uint8Array(95)) }, SHARE],
      [{ ...HEADER, rosterSlot: 1 } as unknown as VaultRecordHeader, SHARE],
      [{ ...HEADER, participants: 2, threshold: 3 } as unknown as VaultRecordHeader, SHARE],
      [{ ...HEADER, extra: 'x' } as unknown as VaultRecordHeader, SHARE],
      [HEADER, new Uint8Array(0)],
      [HEADER, new Uint8Array(4097)]
    ]
    for (const [header, share] of cases) {
      await expect(sealVaultRecord(header, share, MNEMONIC)).rejects.toThrow('Invalid vault record')
    }
  })

  test('identifier rules', () => {
    expect(isVaultGroupId('11111111-2222-4333-8444-555555555555')).toBe(true)
    for (const value of ['', 'a b', 'a:b', 'a'.repeat(129)]) {
      expect(isVaultGroupId(value)).toBe(false)
    }
    expect(isVaultWalletId('wallet:keystone-v2:abc')).toBe(true)
    for (const value of ['', 'a b', 'a\n', 'a'.repeat(129)]) {
      expect(isVaultWalletId(value)).toBe(false)
    }
  })
})
