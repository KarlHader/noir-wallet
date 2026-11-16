import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { parseChainId } from '../../../src/core/chains/registry/index.ts'
import {
  SIGNING_SUMMARY_LIMITS,
  SIGNING_SUMMARY_SCHEMAS,
  parseSigningSummary
} from '../../../src/core/keyring/domain/index.ts'

const digest = '00'.repeat(32)
const evmChainId = parseChainId('eip155:1').id
const bitcoinChainId = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const solanaChainId = parseChainId('solana:mainnet').id
const nearChainId = parseChainId('near:mainnet').id
const zcashChainId = parseChainId('bip122:00040fe8ec8471911baa1db1266ea15d').id

function content(encoding, value, byteLength) {
  return { encoding, value, byteLength, sha256: digest }
}

function expectation(chainId, family, operation) {
  return { chainId, family, operation }
}

function envelope(schema, chainId, operation, fields, review = { level: 'standard', issues: [] }) {
  return { schema, chainId, operation, review, fields }
}

test.describe('Chain-specific signing summaries', () => {
  test('freezes the versioned schema registry', () => {
    expect(Object.isFrozen(SIGNING_SUMMARY_SCHEMAS)).toBe(true)
    expect(SIGNING_SUMMARY_SCHEMAS).toHaveLength(13)
  })

  test('rejects schema, chain, operation, and unknown-field mismatches', () => {
    const summary = envelope('evm.personal-message.v1', evmChainId, 'message', {
      signer: '0x1111111111111111111111111111111111111111',
      message: content('utf8', 'hello', 5)
    })

    expect(() =>
      parseSigningSummary(summary, expectation(evmChainId, 'bitcoin', 'message'))
    ).toThrow(/family|operation/)
    expect(() =>
      parseSigningSummary(summary, expectation(parseChainId('eip155:10').id, 'evm', 'message'))
    ).toThrow(/chainId/)
    expect(() =>
      parseSigningSummary(
        { ...summary, unexpected: true },
        expectation(evmChainId, 'evm', 'message')
      )
    ).toThrow(/unknown field/)
  })

  test('parses an exact EVM native transfer and freezes the decoded copy', () => {
    const fields = {
      transactionType: 'eip1559',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      nonce: '7',
      valueWei: '1000000000000000000',
      gasLimit: '21000',
      maximumFeeWei: '630000000000000',
      gasPriceWei: null,
      maxFeePerGasWei: '30000000000',
      maxPriorityFeePerGasWei: '1000000000',
      accessList: [],
      calldata: content('hex', '0x', 0),
      methodSelector: null
    }
    const parsed = parseSigningSummary(
      envelope('evm.transaction.v1', evmChainId, 'transaction', fields),
      expectation(evmChainId, 'evm', 'transaction')
    )

    fields.valueWei = '0'
    expect(parsed.fields.valueWei).toBe('1000000000000000000')
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.fields)).toBe(true)
    expect(Object.isFrozen(parsed.fields.accessList)).toBe(true)
  })

  test('requires explicit EVM contract-call review and verifies maximum fee math', () => {
    const fields = {
      transactionType: 'legacy',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      nonce: '1',
      valueWei: '0',
      gasLimit: '50000',
      maximumFeeWei: '100000',
      gasPriceWei: '2',
      maxFeePerGasWei: null,
      maxPriorityFeePerGasWei: null,
      accessList: [],
      calldata: content('hex', '0xa9059cbb', 4),
      methodSelector: '0xa9059cbb'
    }
    const unsignedReview = envelope('evm.transaction.v1', evmChainId, 'transaction', fields)
    expect(() =>
      parseSigningSummary(unsignedReview, expectation(evmChainId, 'evm', 'transaction'))
    ).toThrow(/unrecognized-call/)

    const reviewed = envelope('evm.transaction.v1', evmChainId, 'transaction', fields, {
      level: 'caution',
      issues: [{ code: 'unrecognized-call' }]
    })
    expect(
      parseSigningSummary(reviewed, expectation(evmChainId, 'evm', 'transaction')).review.level
    ).toBe('caution')
    expect(() =>
      parseSigningSummary(
        envelope(
          'evm.transaction.v1',
          evmChainId,
          'transaction',
          {
            ...fields,
            maximumFeeWei: '99999'
          },
          reviewed.review
        ),
        expectation(evmChainId, 'evm', 'transaction')
      )
    ).toThrow(/maximum fee/)
  })

  test('preserves typed EIP-712 structure and rejects excessive nesting', () => {
    const scalar = { kind: 'scalar', solidityType: 'string', value: ' Alice ' }
    const typedData = envelope('evm.typed-data.v1', evmChainId, 'message', {
      signer: '0x1111111111111111111111111111111111111111',
      primaryType: 'Mail',
      domain: {
        kind: 'struct',
        typeName: 'EIP712Domain',
        fields: [
          {
            name: 'chainId',
            value: { kind: 'scalar', solidityType: 'uint256', value: '1' }
          }
        ]
      },
      message: {
        kind: 'struct',
        typeName: 'Mail',
        fields: [{ name: 'contents', value: scalar }]
      },
      digestHex: `0x${digest}`
    })
    const parsed = parseSigningSummary(typedData, expectation(evmChainId, 'evm', 'message'))
    expect(parsed.fields.message.fields[0].value.value).toBe(' Alice ')

    let nested = scalar
    for (let index = 0; index < SIGNING_SUMMARY_LIMITS.maxTypedDataDepth + 2; index += 1) {
      nested = { kind: 'array', itemType: 'string[]', items: [nested] }
    }
    expect(() =>
      parseSigningSummary(
        {
          ...typedData,
          fields: {
            ...typedData.fields,
            message: { kind: 'struct', typeName: 'Mail', fields: [{ name: 'x', value: nested }] }
          }
        },
        expectation(evmChainId, 'evm', 'message')
      )
    ).toThrow(/depth/)
  })

  test('balances Bitcoin PSBT values and blocks an unclassified output', () => {
    const fields = {
      psbtVersion: 0,
      signer: 'bc1qsigner',
      inputs: [
        {
          index: 0,
          transactionId: '11'.repeat(32),
          outputIndex: 1,
          amountSats: '10000',
          sequence: 0xffffffff,
          scriptType: 'p2wpkh',
          sighashType: 'SIGHASH_ALL',
          ownership: 'signing-account'
        }
      ],
      outputs: [
        {
          index: 0,
          address: 'bc1qrecipient',
          scriptPubKeyHex: '0x00141111',
          amountSats: '9000',
          classification: 'recipient'
        }
      ],
      signingInputIndexes: [0],
      totalInputSats: '10000',
      totalOutputSats: '9000',
      feeSats: '1000'
    }
    expect(
      parseSigningSummary(
        envelope('bitcoin.psbt.v1', bitcoinChainId, 'transaction', fields),
        expectation(bitcoinChainId, 'bitcoin', 'transaction')
      ).fields.feeSats
    ).toBe('1000')

    for (const [scriptType, sighashType] of [
      ['p2pkh', 'SIGHASH_ALL'],
      ['p2sh-p2wpkh', 'SIGHASH_ALL'],
      ['p2tr', 'SIGHASH_DEFAULT']
    ]) {
      expect(
        parseSigningSummary(
          envelope('bitcoin.psbt.v1', bitcoinChainId, 'transaction', {
            ...fields,
            inputs: [{ ...fields.inputs[0], scriptType, sighashType }]
          }),
          expectation(bitcoinChainId, 'bitcoin', 'transaction')
        ).fields.inputs[0]
      ).toMatchObject({ scriptType, sighashType })
    }

    const unknownOutput = {
      ...fields,
      outputs: [{ ...fields.outputs[0], classification: 'unknown' }]
    }
    expect(() =>
      parseSigningSummary(
        envelope('bitcoin.psbt.v1', bitcoinChainId, 'transaction', unknownOutput, {
          level: 'caution',
          issues: [{ code: 'unknown-output', subjectIndex: 0 }]
        }),
        expectation(bitcoinChainId, 'bitcoin', 'transaction')
      )
    ).toThrow(/blocked/)
  })

  test('binds Solana fee payer, account keys, and every instruction interpretation', () => {
    const feePayer = 'Vote111111111111111111111111111111111111111'
    const recipient = 'SysvarRent111111111111111111111111111111111'
    const fields = {
      messageVersion: 'legacy',
      feePayer,
      recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
      requiredSigners: [feePayer],
      staticAccountKeys: [feePayer, recipient, '11111111111111111111111111111111'],
      addressTableLookups: [],
      feeLamports: null,
      computeUnitLimit: null,
      computeUnitPriceMicroLamports: null,
      maximumPriorityFeeLamports: null,
      simulationStatus: 'not-run',
      simulationUnitsConsumed: null,
      instructions: [
        {
          index: 0,
          programId: '11111111111111111111111111111111',
          accounts: [
            { address: feePayer, signer: true, writable: true, source: 'static' },
            { address: recipient, signer: false, writable: true, source: 'static' }
          ],
          data: content('base64', 'AQ==', 1),
          interpretation: {
            kind: 'system-transfer',
            from: feePayer,
            to: recipient,
            lamports: '5000'
          }
        }
      ]
    }
    expect(
      parseSigningSummary(
        envelope('solana.transaction.v1', solanaChainId, 'transaction', fields),
        expectation(solanaChainId, 'solana', 'transaction')
      ).fields.instructions[0].interpretation.kind
    ).toBe('system-transfer')

    const opaqueFields = {
      ...fields,
      instructions: [
        {
          ...fields.instructions[0],
          interpretation: { kind: 'unrecognized' }
        }
      ]
    }
    expect(
      parseSigningSummary(
        envelope('solana.transaction.v1', solanaChainId, 'transaction', opaqueFields, {
          level: 'caution',
          issues: [{ code: 'unrecognized-instruction', subjectIndex: 0 }]
        }),
        expectation(solanaChainId, 'solana', 'transaction')
      ).review.level
    ).toBe('caution')
    expect(() =>
      parseSigningSummary(
        envelope('solana.transaction.v1', solanaChainId, 'transaction', opaqueFields),
        expectation(solanaChainId, 'solana', 'transaction')
      )
    ).toThrow(/warning/)
  })

  test('binds Solana compute budget instructions to the quoted priority fee', () => {
    const feePayer = 'Vote111111111111111111111111111111111111111'
    const computeProgram = 'ComputeBudget111111111111111111111111111111'
    const fields = {
      messageVersion: 'legacy',
      feePayer,
      recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
      requiredSigners: [feePayer],
      staticAccountKeys: [feePayer, computeProgram],
      addressTableLookups: [],
      feeLamports: '5050',
      computeUnitLimit: '200000',
      computeUnitPriceMicroLamports: '250',
      maximumPriorityFeeLamports: '50',
      simulationStatus: 'succeeded',
      simulationUnitsConsumed: '12345',
      instructions: [
        {
          index: 0,
          programId: computeProgram,
          accounts: [],
          data: content('base64', 'AsANAwA=', 5),
          interpretation: { kind: 'compute-unit-limit', units: '200000' }
        },
        {
          index: 1,
          programId: computeProgram,
          accounts: [],
          data: content('base64', 'A/oAAAAAAAAA', 9),
          interpretation: { kind: 'compute-unit-price', microLamports: '250' }
        }
      ]
    }
    const parsed = parseSigningSummary(
      envelope('solana.transaction.v1', solanaChainId, 'transaction', fields),
      expectation(solanaChainId, 'solana', 'transaction')
    )
    expect(parsed.fields).toMatchObject({
      computeUnitLimit: '200000',
      computeUnitPriceMicroLamports: '250',
      maximumPriorityFeeLamports: '50'
    })
    expect(() =>
      parseSigningSummary(
        envelope('solana.transaction.v1', solanaChainId, 'transaction', {
          ...fields,
          maximumPriorityFeeLamports: '49'
        }),
        expectation(solanaChainId, 'solana', 'transaction')
      )
    ).toThrow(/does not match/)
  })

  test('represents NEAR Actions without collapsing them into a generic transfer', () => {
    const fields = {
      signerId: 'alice.near',
      publicKey: 'ed25519:11111111111111111111111111111111',
      nonce: '42',
      receiverId: 'contract.near',
      blockHash: '11111111111111111111111111111111',
      actions: [
        {
          kind: 'function-call',
          methodName: 'ft_transfer',
          args: content('base64', 'e30=', 2),
          gas: '30000000000000',
          depositYocto: '1'
        },
        {
          kind: 'add-key',
          publicKey: 'ed25519:11111111111111111111111111111111',
          nonce: '0',
          permission: {
            kind: 'function-call',
            allowanceYocto: null,
            receiverId: 'contract.near',
            methodNames: ['claim']
          }
        }
      ]
    }
    const parsed = parseSigningSummary(
      envelope('near.transaction.v1', nearChainId, 'transaction', fields),
      expectation(nearChainId, 'near', 'transaction')
    )
    expect(parsed.fields.actions.map(action => action.kind)).toEqual(['function-call', 'add-key'])

    const unknownAction = {
      ...fields,
      actions: [{ kind: 'unrecognized', actionTag: 9, payload: { byteLength: 4, sha256: digest } }]
    }
    expect(() =>
      parseSigningSummary(
        envelope('near.transaction.v1', nearChainId, 'transaction', unknownAction, {
          level: 'standard',
          issues: []
        }),
        expectation(nearChainId, 'near', 'transaction')
      )
    ).toThrow(/unrecognized-action/)
  })

  test('accepts NEP-413 recipient identifiers and binds the 32-byte nonce', () => {
    const summary = envelope('near.nep413-message.v1', nearChainId, 'message', {
      signerId: 'alice.near',
      publicKey: 'ed25519:11111111111111111111111111111111',
      message: content('utf8', ' sign me ', 9),
      nonceBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      recipient: 'myapp.com',
      callbackUrl: 'myapp.com/callback'
    })
    const parsed = parseSigningSummary(summary, expectation(nearChainId, 'near', 'message'))
    expect(parsed.fields.recipient).toBe('myapp.com')
    expect(parsed.fields.message.value).toBe(' sign me ')
    expect(() =>
      parseSigningSummary(
        {
          ...summary,
          fields: { ...summary.fields, nonceBase64: 'AA==' }
        },
        expectation(nearChainId, 'near', 'message')
      )
    ).toThrow(/nonce/)
  })

  test('validates Zcash pool totals and exact memo content', () => {
    const fields = {
      kind: 'transfer',
      signer: 'u1sender',
      fundingSource: 'shielded',
      recipients: [
        {
          address: 'u1recipient',
          amountZats: '9000',
          memo: content('utf8', ' private memo ', 14)
        }
      ],
      feeZats: '1000',
      transparentInputZats: '0',
      shieldedInputZats: '10000',
      transparentOutputZats: '0',
      shieldedOutputZats: '9000'
    }
    const parsed = parseSigningSummary(
      envelope('zcash.transaction.v1', zcashChainId, 'transaction', fields),
      expectation(zcashChainId, 'zcash', 'transaction')
    )
    expect(parsed.fields.recipients[0].memo.value).toBe(' private memo ')
    expect(() =>
      parseSigningSummary(
        envelope('zcash.transaction.v1', zcashChainId, 'transaction', {
          ...fields,
          feeZats: '999'
        }),
        expectation(zcashChainId, 'zcash', 'transaction')
      )
    ).toThrow(/balance/)
  })

  test('keeps summary decoders independent from browser, worker, store, and WASM packages', () => {
    const source = [
      'signing-summary.ts',
      'signing-summary-validation.ts',
      'signing-summary-validation-zcash-evm.ts',
      'signing-summary-validation-bitcoin.ts',
      'signing-summary-validation-solana.ts',
      'signing-summary-validation-tron.ts',
      'signing-summary-validation-tron-contract.ts',
      'signing-summary-validation-near.ts'
    ]
      .map(file =>
        readFileSync(new URL(`../../../src/core/keyring/domain/${file}`, import.meta.url), 'utf8')
      )
      .join('\n')

    expect(source).not.toMatch(/chrome\.|postMessage|WORKER_RPC|wasm-pkg/i)
    expect(source).not.toMatch(/from ['"](?:react|zustand|@\/store)/)
    expect(source).not.toMatch(/console\.(?:log|warn|error)/)
  })
})
