import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { expect } from '@playwright/test'
import { blake2b } from '@noble/hashes/blake2b'

import {
  adaptPreparedSigning,
  adaptSignedResult,
  parseSigningPreparePayload
} from '../../../../src/infrastructure/keyring/multichain/signing-adapter.ts'
import { parseQuantusTransferPrepareRequest } from '../../../../src/infrastructure/keyring/multichain/signing-adapter-quantus.ts'
import { computeQuantusTransferFingerprint } from '../../../../src/infrastructure/keyring/multichain/quantus-signing-client.ts'
import { decodeQuantusAccountId } from '../../../../src/core/chains/quantus/identifiers.ts'
import { bytesToHex, hexToBytes } from '../../../../src/lib/bytes.ts'

const ADDRESS = 'qzna4bUiEiZdXQpwvSQDmM2y9rBPyJRS9iNm85jPgicM76kA8'
const RECIPIENT = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'
const GENESIS = `0x${'11'.repeat(32)}`
const ERA_BLOCK = `0x${'22'.repeat(32)}`
const RECIPIENT_ACCOUNT_ID = `0x${bytesToHex(decodeQuantusAccountId(RECIPIENT))}`
// balances.transfer_keep_alive(recipient, amount) shape: pallet, call, account id, amount, mode.
const CALL = `0x020300${RECIPIENT_ACCOUNT_ID.slice(2)}070010a5d4e8`
const CALL_BYTES = hexToBytes(CALL)
const CALL_HASH = `0x${bytesToHex(blake2b(CALL_BYTES, { dkLen: 32 }))}`
const CALL_LENGTH = CALL_BYTES.byteLength

const account = {
  accountId: `0x${'cd'.repeat(32)}`,
  address: ADDRESS,
  derivationPath: "m/44'/189189'/0'/0'/0'",
  publicKey: `0x${'ab'.repeat(2592)}`,
  curve: 'ml_dsa87',
  addressScheme: 'quantus',
  derivationScheme: 'bip44',
  scheme: 'ml-dsa-87',
  network: 'mainnet'
}

const importedAccount = {
  ...account,
  derivationPath: 'm',
  derivationScheme: 'imported'
}

function payload(overrides = {}) {
  return {
    kind: 'quantus-transfer',
    chainId: 'quantus:mainnet',
    scheme: 'ml-dsa-87',
    accountIndex: 0,
    toAddress: RECIPIENT,
    amountRaw: '1000000000000',
    feeLimitRaw: '10000000000',
    keepAlive: true,
    nonce: 7,
    tip: '0',
    period: 64,
    blockNumber: 128,
    genesisHash: GENESIS,
    blockHash: ERA_BLOCK,
    specVersion: 153,
    transactionVersion: 1,
    allowImmortal: false,
    ...overrides
  }
}

function rawPrepared(overrides = {}, accountOverrides = {}, transferOverrides = {}) {
  return {
    requestId: 3,
    account: { ...account, ...accountOverrides },
    call: CALL,
    transfer: {
      recipient: RECIPIENT_ACCOUNT_ID,
      amount: '1000000000000',
      keepAlive: true,
      ...transferOverrides
    },
    summary: {
      chainId: 'quantus:mainnet',
      network: 'mainnet',
      genesisHash: GENESIS,
      address: ADDRESS,
      accountId: account.accountId,
      scheme: 'ml-dsa-87',
      nonce: 7,
      tip: '0',
      period: 64,
      blockNumber: 128,
      callHash: CALL_HASH,
      callLength: CALL_LENGTH,
      allowImmortal: false,
      ...overrides
    }
  }
}

function signedCall(overrides = {}) {
  return {
    extrinsic: '0x8400',
    extrinsicHash: `0x${'55'.repeat(32)}`,
    callHash: CALL_HASH,
    address: ADDRESS,
    accountId: account.accountId,
    scheme: 'ml-dsa-87',
    nonce: 7,
    ...overrides
  }
}

const EXPIRES_AT = 1_800_000_000_000

test.describe('Quantus signing prepare payload', () => {
  test('builds the exact WASM transfer request and resolves the default scheme', () => {
    const parsed = parseSigningPreparePayload(payload({ scheme: undefined }))

    expect(parsed).toMatchObject({
      kind: 'quantus-transfer',
      chainId: 'quantus:mainnet',
      accountIndex: 0,
      feeLimitRaw: '10000000000',
      scheme: 'ml-dsa-87'
    })
    expect(Object.keys(parsed.transfer).sort()).toEqual([
      'accountIndex',
      'allowImmortal',
      'amount',
      'blockHash',
      'blockNumber',
      'chainId',
      'genesisHash',
      'keepAlive',
      'nonce',
      'period',
      'recipient',
      'scheme',
      'specVersion',
      'tip',
      'transactionVersion'
    ])
  })

  test('keeps the host chain ID while translating it for the engine boundary', () => {
    const parsed = parseSigningPreparePayload(payload({ chainId: 'quantus:planck' }))
    expect(parsed.chainId).toBe('quantus:planck')
    expect(parsed.transfer.chainId).toBe('quantus:dev')
  })

  test('requires a canonical positive u128 fee ceiling on both request parsers', () => {
    for (const feeLimitRaw of [
      undefined,
      null,
      0,
      '',
      '0',
      '01',
      '+1',
      '1.0',
      '-1',
      ' 1',
      (1n << 128n).toString()
    ]) {
      expect(() => parseSigningPreparePayload(payload({ feeLimitRaw }))).toThrow()
      expect(() => parseQuantusTransferPrepareRequest(payload({ feeLimitRaw }))).toThrow()
    }
    const maximum = ((1n << 128n) - 1n).toString()
    expect(parseSigningPreparePayload(payload({ feeLimitRaw: maximum })).feeLimitRaw).toBe(maximum)
    expect(
      parseQuantusTransferPrepareRequest(payload({ feeLimitRaw: maximum })).request.feeLimitRaw
    ).toBe(maximum)
  })

  test('round-trips the reviewed fee ceiling through the persisted request', () => {
    const { request, payload: parsed } = parseQuantusTransferPrepareRequest(payload())
    expect(request.feeLimitRaw).toBe(parsed.feeLimitRaw)
    expect(parseSigningPreparePayload(request).feeLimitRaw).toBe(parsed.feeLimitRaw)
  })

  test('fingerprints distinct fee ceilings without changing the WASM request', async () => {
    const baseline = parseSigningPreparePayload(payload())
    const changed = parseSigningPreparePayload(payload({ feeLimitRaw: '20000000000' }))
    expect(changed.transfer).toEqual(baseline.transfer)
    expect(
      await computeQuantusTransferFingerprint(baseline.transfer, baseline.feeLimitRaw)
    ).not.toBe(await computeQuantusTransferFingerprint(changed.transfer, changed.feeLimitRaw))
  })

  test('rejects unknown fields and non-positive amounts', () => {
    expect(() => parseSigningPreparePayload({ ...payload(), extra: 1 })).toThrow(/unknown field/)
    expect(() => parseSigningPreparePayload(payload({ amountRaw: '0' }))).toThrow(/positive/)
    expect(() => parseSigningPreparePayload(payload({ toAddress: '0x1234' }))).toThrow()
    expect(() => parseSigningPreparePayload(payload({ chainId: 'quantus:dev' }))).toThrow(
      /Unsupported Quantus chain ID/
    )
  })
})

test.describe('Quantus signing adapter binding', () => {
  test('builds a quantus.transfer.v1 review from the prepared request', async () => {
    const parsed = parseSigningPreparePayload(payload())
    const adapted = await adaptPreparedSigning(
      rawPrepared(),
      parsed,
      'signing-command:quantus',
      EXPIRES_AT
    )

    expect(adapted).toMatchObject({
      rawRequestId: 3,
      kind: 'quantus-transfer',
      account: { address: ADDRESS, scheme: 'ml-dsa-87' }
    })
    expect(adapted.prepared).toMatchObject({
      commandId: 'signing-command:quantus',
      chainId: 'quantus:mainnet',
      operation: 'transaction',
      execution: { kind: 'internal' },
      expiresAt: EXPIRES_AT,
      summary: {
        schema: 'quantus.transfer.v1',
        operation: 'transaction',
        review: { level: 'standard', issues: [] },
        fields: {
          signerAddress: ADDRESS,
          signerAccountId: account.accountId,
          scheme: 'ml-dsa-87',
          recipient: RECIPIENT,
          amountRaw: '1000000000000',
          feeLimitRaw: '10000000000',
          keepAlive: true,
          nonce: '7',
          tipRaw: '0',
          eraPeriod: 64,
          blockNumber: 128,
          callHash: CALL_HASH,
          callLength: CALL_LENGTH
        }
      }
    })
    expect(adapted.prepared.payloadFingerprint).toEqual({
      algorithm: 'sha256',
      digestHex: createHash('sha256')
        .update(JSON.stringify({ ...parsed.transfer, feeLimitRaw: '10000000000' }))
        .digest('hex')
    })
  })

  test('fingerprints the normalized transfer so equivalent payloads review identically', async () => {
    const explicit = parseSigningPreparePayload(payload())
    const implicit = parseSigningPreparePayload(payload({ scheme: undefined }))
    const reviewed = await adaptPreparedSigning(
      rawPrepared(),
      explicit,
      'signing-command:fp-a',
      EXPIRES_AT
    )
    const equivalent = await adaptPreparedSigning(
      rawPrepared(),
      implicit,
      'signing-command:fp-b',
      EXPIRES_AT
    )
    expect(equivalent.prepared.payloadFingerprint).toEqual(reviewed.prepared.payloadFingerprint)

    const changed = await adaptPreparedSigning(
      rawPrepared({}, {}, { amount: '1' }),
      parseSigningPreparePayload(payload({ amountRaw: '1' })),
      'signing-command:fp-c',
      EXPIRES_AT
    )
    expect(changed.prepared.payloadFingerprint.digestHex).not.toBe(
      reviewed.prepared.payloadFingerprint.digestHex
    )
  })

  test('rejects a reviewed intent that the prepared summary does not answer', async () => {
    const parsed = parseSigningPreparePayload(payload())

    await expect(
      adaptPreparedSigning(rawPrepared({ nonce: 8 }), parsed, 'signing-command:a', EXPIRES_AT)
    ).rejects.toThrow(/does not match its request/)
    await expect(
      adaptPreparedSigning(
        rawPrepared({ address: RECIPIENT }),
        parsed,
        'signing-command:b',
        EXPIRES_AT
      )
    ).rejects.toThrow(/does not match the signing account/)
    await expect(
      adaptPreparedSigning(rawPrepared({ network: 'dev' }), parsed, 'signing-command:c', EXPIRES_AT)
    ).rejects.toThrow(/does not match the signing account/)
    await expect(
      adaptPreparedSigning(
        rawPrepared({ network: 'dev', chainId: 'quantus:dev' }, { network: 'dev' }),
        parsed,
        'signing-command:d',
        EXPIRES_AT
      )
    ).rejects.toThrow(/does not match/)
    await expect(
      adaptPreparedSigning({ ...rawPrepared(), extra: 1 }, parsed, 'signing-command:e', EXPIRES_AT)
    ).rejects.toThrow(/unknown field/)
  })

  test('binds an imported account to index zero without inventing an HD path', async () => {
    const parsed = parseSigningPreparePayload(payload())
    const adapted = await adaptPreparedSigning(
      { ...rawPrepared(), account: importedAccount },
      parsed,
      'signing-command:imported',
      EXPIRES_AT,
      undefined,
      true
    )
    expect(adapted.account).toMatchObject({ derivationScheme: 'imported', derivationPath: 'm' })
    await expect(
      adaptPreparedSigning(
        { ...rawPrepared(), account: importedAccount },
        parsed,
        'signing-command:not-imported',
        EXPIRES_AT
      )
    ).rejects.toThrow(/does not match its request/)
  })
})

test.describe('Quantus signed result', () => {
  test('returns the signed extrinsic bound to the prepared account', () => {
    expect(adaptSignedResult('quantus-transfer', signedCall(), account)).toEqual({
      kind: 'signed-payload',
      payload: { encoding: 'hex', value: '0x8400' },
      transactionId: `0x${'55'.repeat(32)}`
    })
  })

  test('rejects a signed call for another signer', () => {
    expect(() =>
      adaptSignedResult('quantus-transfer', signedCall({ address: RECIPIENT }), account)
    ).toThrow(/does not match the prepared account/)
    expect(() => adaptSignedResult('quantus-transfer', signedCall(), importedAccount)).not.toThrow()
    expect(() => adaptSignedResult('quantus-transfer', signedCall({ extra: 1 }), account)).toThrow(
      /unknown field/
    )
  })
})
