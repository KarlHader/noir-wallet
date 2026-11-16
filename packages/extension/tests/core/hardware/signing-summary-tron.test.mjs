import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseChainId } from '../../../src/core/chains/registry/index.ts'
import { parseSigningSummary } from '../../../src/core/keyring/domain/index.ts'

const digest = '00'.repeat(32)
const tronChainId = parseChainId('tron:0x2b6653dc').id
const signer = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const owner = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'
const receiver = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'
const maxU256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function content(encoding, value, byteLength) {
  return { encoding, value, byteLength, sha256: digest }
}

function envelope(schema, operation, fields, review = { level: 'standard', issues: [] }) {
  return { schema, chainId: tronChainId, operation, review, fields }
}

function expectation(operation) {
  return { chainId: tronChainId, family: 'tron', operation }
}

function addressPayloadHex(address) {
  let decoded = 0n
  for (const character of address) {
    decoded = decoded * 58n + BigInt(base58Alphabet.indexOf(character))
  }
  return decoded.toString(16).padStart(50, '0').slice(2, 42)
}

function addressWord(address) {
  return addressPayloadHex(address).padStart(64, '0')
}

function uintWord(value) {
  return BigInt(value).toString(16).padStart(64, '0')
}

function calldata(selector, words) {
  const value = `${selector}${words.join('')}`
  return content('hex', value, (value.length - 2) / 2)
}

function transactionFields(contract, overrides = {}) {
  return {
    signer,
    owner: contract.owner,
    ownerMatchesSigner: contract.owner === signer,
    permissionId: 0,
    transactionId: digest,
    rawData: { byteLength: 128, sha256: digest },
    refBlockBytes: 'abcd',
    refBlockNum: '123456',
    refBlockHash: '11'.repeat(8),
    expirationMs: '1700000060000',
    timestampMs: '1700000000000',
    feeLimitSun: '100000000',
    memo: content('utf8', '', 0),
    existingSigners: [],
    contract,
    ...overrides
  }
}

function parseTransaction(fields, review) {
  return parseSigningSummary(
    envelope('tron.transaction.v1', 'transaction', fields, review),
    expectation('transaction')
  )
}

const standardContracts = [
  {
    type: 'transfer',
    owner: signer,
    to: receiver,
    amountSun: '2500000'
  },
  {
    type: 'transfer-asset',
    owner: signer,
    to: receiver,
    assetName: content('utf8', '1002000', 7),
    amountRaw: '25'
  },
  {
    type: 'vote-witness',
    owner: signer,
    votes: [
      { voteAddress: owner, voteCount: '2' },
      { voteAddress: receiver, voteCount: '3' }
    ]
  },
  {
    type: 'trigger-smart-contract',
    owner: signer,
    contractAddress: owner,
    callValueSun: '0',
    callTokenValue: '0',
    tokenId: '0',
    calldata: calldata('0xa9059cbb', [addressWord(receiver), uintWord('25')]),
    methodSelector: '0xa9059cbb',
    interpretation: { kind: 'trc20-transfer', to: receiver, amountRaw: '25' }
  },
  {
    type: 'freeze-balance-v2',
    owner: signer,
    resource: 'energy',
    amountSun: '3000000'
  },
  {
    type: 'unfreeze-balance-v2',
    owner: signer,
    resource: 'bandwidth',
    amountSun: '1000000'
  },
  { type: 'withdraw-expire-unfreeze', owner: signer },
  {
    type: 'delegate-resource',
    owner: signer,
    receiver,
    resource: 'energy',
    amountSun: '3000000',
    locked: true,
    lockPeriod: '28800'
  },
  {
    type: 'undelegate-resource',
    owner: signer,
    receiver,
    resource: 'bandwidth',
    amountSun: '1000000'
  },
  { type: 'cancel-all-unfreeze-v2', owner: signer }
]

test.describe('TRON signing summaries', () => {
  test('parses all ten supported Contract variants without generic-transfer fallback', () => {
    const parsedTypes = standardContracts.map(contract => {
      const parsed = parseTransaction(transactionFields(contract))
      expect(Object.isFrozen(parsed)).toBe(true)
      expect(Object.isFrozen(parsed.fields.contract)).toBe(true)
      return parsed.fields.contract.type
    })

    expect(parsedTypes).toEqual(standardContracts.map(contract => contract.type))
  })

  test('requires explicit active-permission, owner mismatch, and multisign review', () => {
    const contract = { type: 'transfer', owner, to: receiver, amountSun: '1000000' }
    const fields = transactionFields(contract, {
      signer,
      owner,
      ownerMatchesSigner: false,
      permissionId: 2,
      existingSigners: [receiver]
    })
    const review = {
      level: 'caution',
      issues: [
        { code: 'active-permission' },
        { code: 'owner-signer-mismatch' },
        { code: 'multisign' }
      ]
    }

    expect(parseTransaction(fields, review).fields.permissionId).toBe(2)
    expect(() =>
      parseTransaction(fields, {
        level: 'caution',
        issues: review.issues.filter(issue => issue.code !== 'active-permission')
      })
    ).toThrow(/active-permission/)
    expect(
      parseTransaction(
        { ...fields, permissionId: 0 },
        {
          level: 'caution',
          issues: [{ code: 'owner-signer-mismatch' }, { code: 'multisign' }]
        }
      ).review.level
    ).toBe('caution')
    expect(() => parseTransaction({ ...fields, existingSigners: [signer] }, review)).toThrow(
      /already be present/
    )
  })

  test('binds TRC-20 approval interpretation and flags unlimited allowance', () => {
    const approval = {
      type: 'trigger-smart-contract',
      owner: signer,
      contractAddress: owner,
      callValueSun: '0',
      callTokenValue: '0',
      tokenId: '0',
      calldata: calldata('0x095ea7b3', [addressWord(receiver), uintWord(maxU256)]),
      methodSelector: '0x095ea7b3',
      interpretation: { kind: 'trc20-approve', spender: receiver, amountRaw: maxU256 }
    }
    const review = {
      level: 'caution',
      issues: [{ code: 'token-approval' }, { code: 'unlimited-token-approval' }]
    }

    expect(parseTransaction(transactionFields(approval), review).review.level).toBe('caution')
    expect(() =>
      parseTransaction(transactionFields(approval), {
        level: 'caution',
        issues: [{ code: 'token-approval' }]
      })
    ).toThrow(/unlimited-token-approval/)
    expect(() =>
      parseTransaction(
        transactionFields({
          ...approval,
          interpretation: { ...approval.interpretation, amountRaw: '1' }
        }),
        review
      )
    ).toThrow(/uint256 interpretation/)

    const transferFrom = {
      ...approval,
      calldata: calldata('0x23b872dd', [addressWord(owner), addressWord(receiver), uintWord('42')]),
      methodSelector: '0x23b872dd',
      interpretation: {
        kind: 'trc20-transfer-from',
        from: owner,
        to: receiver,
        amountRaw: '42'
      }
    }
    expect(
      parseTransaction(transactionFields(transferFrom)).fields.contract.interpretation.kind
    ).toBe('trc20-transfer-from')
  })

  test('blocks unknown smart-contract calldata instead of treating it as a transfer', () => {
    const contract = {
      type: 'trigger-smart-contract',
      owner: signer,
      contractAddress: owner,
      callValueSun: '0',
      callTokenValue: '0',
      tokenId: '0',
      calldata: content('hex', '0x12345678', 4),
      methodSelector: '0x12345678',
      interpretation: { kind: 'unrecognized' }
    }

    expect(() =>
      parseTransaction(transactionFields(contract), {
        level: 'caution',
        issues: [{ code: 'unrecognized-call' }]
      })
    ).toThrow(/blocked/)
    expect(
      parseTransaction(transactionFields(contract), {
        level: 'blocked',
        issues: [{ code: 'unrecognized-call' }]
      }).review.level
    ).toBe('blocked')
  })

  test('rejects unknown, inconsistent, expired, and non-canonical transaction summaries', () => {
    const contract = standardContracts[0]
    const fields = transactionFields(contract)

    expect(() => parseTransaction({ ...fields, unexpected: true })).toThrow(/unknown field/)
    expect(() =>
      parseTransaction({ ...fields, rawData: { ...fields.rawData, sha256: '11'.repeat(32) } })
    ).toThrow(/transaction ID/)
    expect(() => parseTransaction({ ...fields, expirationMs: fields.timestampMs })).toThrow(
      /expiration/
    )
    expect(() => parseTransaction({ ...fields, timestampMs: '0' })).toThrow(/positive/)
    expect(() => parseTransaction({ ...fields, signer: owner, ownerMatchesSigner: true })).toThrow(
      /ownerMatchesSigner/
    )
    expect(() =>
      parseTransaction({ ...fields, contract: { ...contract, type: 'unknown-contract' } })
    ).toThrow(/contract.*type/i)
    expect(() => parseTransaction({ ...fields, signer: `X${signer.slice(1)}` })).toThrow(
      /Base58Check/
    )
    expect(() =>
      parseTransaction({
        ...fields,
        signer: `${signer.slice(0, -1)}J`,
        ownerMatchesSigner: false
      })
    ).toThrow(/checksummed/)
  })

  test('binds signMessageV2 prefix, full content, signer, and signing hash', () => {
    const summary = envelope('tron.sign-message-v2.v1', 'message', {
      signer,
      prefix: '\u0019TRON Signed Message:\n',
      message: content('utf8', 'TRON ownership proof', 20),
      signingHash: digest
    })
    const parsed = parseSigningSummary(summary, expectation('message'))

    expect(parsed.fields.message.value).toBe('TRON ownership proof')
    expect(() =>
      parseSigningSummary(
        { ...summary, fields: { ...summary.fields, prefix: 'Ethereum Signed Message' } },
        expectation('message')
      )
    ).toThrow(/prefix/)
    expect(() =>
      parseSigningSummary(
        {
          ...summary,
          fields: { ...summary.fields, message: content('hex', '0xff', 1) }
        },
        expectation('message')
      )
    ).toThrow(/opaque-message/)
  })
})
