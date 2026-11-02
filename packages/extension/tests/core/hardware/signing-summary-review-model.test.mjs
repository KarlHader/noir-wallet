import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { SIGNING_SUMMARY_SCHEMAS } from '../../../src/core/keyring/domain/index.ts'
import { buildSigningSummaryReviewModel } from '../../../src/popup/components/signing/signing-summary-review-model.ts'

const digest = '00'.repeat(32)
const content = (encoding = 'utf8', value = 'hello') => ({
  encoding,
  value,
  byteLength: value.length,
  sha256: digest
})
const review = { level: 'standard', issues: [] }

function summary(schema, chainId, operation, fields, summaryReview = review) {
  return { schema, chainId, operation, review: summaryReview, fields }
}

const baseSummaries = [
  summary('zcash.transaction.v1', 'bip122:zcash', 'transaction', {
    kind: 'transfer',
    signer: 'u1sender',
    fundingSource: 'shielded',
    recipients: [{ address: 'u1recipient', amountZats: '9000' }],
    feeZats: '1000',
    transparentInputZats: '0',
    shieldedInputZats: '10000',
    transparentOutputZats: '0',
    shieldedOutputZats: '9000'
  }),
  summary('zcash.message.v1', 'bip122:zcash', 'message', {
    signer: 'u1sender',
    message: content()
  }),
  summary('evm.transaction.v1', 'eip155:1', 'transaction', {
    transactionType: 'eip1559',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    nonce: '1',
    valueWei: '1',
    gasLimit: '21000',
    maximumFeeWei: '2',
    gasPriceWei: null,
    maxFeePerGasWei: '1',
    maxPriorityFeePerGasWei: '1',
    accessList: [],
    calldata: content('hex', '0x'),
    methodSelector: null
  }),
  summary('evm.personal-message.v1', 'eip155:1', 'message', {
    signer: '0x1111111111111111111111111111111111111111',
    message: content()
  }),
  summary('evm.typed-data.v1', 'eip155:1', 'message', {
    signer: '0x1111111111111111111111111111111111111111',
    primaryType: 'Mail',
    domain: { kind: 'struct', typeName: 'Domain', fields: [] },
    message: { kind: 'scalar', solidityType: 'string', value: 'hello' },
    digestHex: `0x${digest}`
  }),
  summary('bitcoin.psbt.v1', 'bip122:bitcoin', 'transaction', {
    psbtVersion: 0,
    signer: 'bc1qsigner',
    inputs: [
      {
        index: 0,
        transactionId: digest,
        outputIndex: 0,
        amountSats: '1000',
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
        scriptPubKeyHex: '0014',
        amountSats: '900',
        classification: 'recipient'
      }
    ],
    signingInputIndexes: [0],
    totalInputSats: '1000',
    totalOutputSats: '900',
    feeSats: '100'
  }),
  summary('bitcoin.bip322-message.v1', 'bip122:bitcoin', 'message', {
    address: 'bc1qsigner',
    message: content()
  }),
  summary('solana.transaction.v1', 'solana:mainnet', 'transaction', {
    messageVersion: 'legacy',
    feePayer: 'FeePayer111111111111111111111111111111111',
    recentBlockhash: 'Blockhash11111111111111111111111111111111',
    requiredSigners: ['FeePayer111111111111111111111111111111111'],
    staticAccountKeys: [],
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
        accounts: [],
        data: content('base64', 'AQ=='),
        interpretation: {
          kind: 'system-transfer',
          from: 'FeePayer111111111111111111111111111111111',
          to: 'Recipient11111111111111111111111111111111',
          lamports: '1'
        }
      }
    ]
  }),
  summary('solana.message.v1', 'solana:mainnet', 'message', {
    signer: 'FeePayer111111111111111111111111111111111',
    domain: 'example.com',
    message: content()
  }),
  summary('tron.sign-message-v2.v1', 'tron:0x2b6653dc', 'message', {
    signer: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
    prefix: '\u0019TRON Signed Message:\n',
    message: content(),
    signingHash: digest
  }),
  summary('near.transaction.v1', 'near:mainnet', 'transaction', {
    signerId: 'alice.near',
    publicKey: 'ed25519:public-key',
    nonce: '1',
    receiverId: 'bob.near',
    blockHash: digest,
    actions: [{ kind: 'transfer', depositYocto: '1' }]
  }),
  summary('near.nep413-message.v1', 'near:mainnet', 'message', {
    signerId: 'alice.near',
    publicKey: 'ed25519:public-key',
    message: content(),
    nonceBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    recipient: 'example.com',
    callbackUrl: null
  })
]

test('formats EVM approval amounts and addresses without changing the signing summary', () => {
  const original = baseSummaries.find(item => item.schema === 'evm.transaction.v1')
  const input = {
    ...original,
    fields: { ...original.fields, valueWei: '2000000000000000', maximumFeeWei: '27019822240488' }
  }
  const before = JSON.stringify(input)
  const model = buildSigningSummaryReviewModel(input, {
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    directContract: true
  })
  const rows = model.sections[0].rows
  expect(rows.find(row => row.label === 'From')).toMatchObject({
    value: '0x1111...111111',
    title: input.fields.from
  })
  expect(rows.find(row => row.label === 'Value')).toMatchObject({ value: '0.002 ETH' })
  expect(rows.find(row => row.label === 'Value').title).toBeUndefined()
  expect(rows.find(row => row.label === 'Maximum fee')).toMatchObject({
    value: '0.00002702 ETH',
    amount: { value: '0.000027019822240488', symbol: 'ETH', profile: 'fee' }
  })
  expect(rows.find(row => row.label === 'Maximum fee').title).toBeUndefined()
  expect(rows.find(row => row.label === 'Execution').value).toBe('Public on-chain')
  expect(JSON.stringify(input)).toBe(before)
  const tiny = buildSigningSummaryReviewModel(original, {
    nativeCurrency: { symbol: 'BNB', decimals: 18 }
  })
  expect(tiny.sections[0].rows.find(row => row.label === 'Value')).toMatchObject({
    value: '<0.00000001 BNB',
    amount: { value: '0.000000000000000001', symbol: 'BNB', profile: 'review' }
  })
})

test('shows requested ERC-20 call arguments only for canonical calldata of known tokens', () => {
  const original = baseSummaries.find(item => item.schema === 'evm.transaction.v1')
  const word = value => value.toString(16).padStart(64, '0')
  const addressWord = address => address.slice(2).padStart(64, '0')
  const tokenContract = original.fields.to
  const recipient = '0x3333333333333333333333333333333333333333'
  const sender = '0x4444444444444444444444444444444444444444'
  const options = {
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
    tokenMetadata: [{ contractAddress: tokenContract, symbol: 'USDC', decimals: 6 }]
  }
  const reviewCall = calldata => {
    const input = {
      ...original,
      fields: {
        ...original.fields,
        valueWei: '0',
        calldata: content('hex', calldata),
        methodSelector: calldata.slice(0, 10)
      }
    }
    return buildSigningSummaryReviewModel(input, options)
  }
  const approve = reviewCall(`0x095ea7b3${addressWord(recipient)}${word(1_500_000)}`)
  const requestRows = approve.sections.find(section => section.title === 'Calldata request').rows
  expect(approve.sections[0].rows.find(row => row.label === 'Native value')).toMatchObject({
    value: '0 ETH'
  })
  expect(requestRows.find(row => row.label === 'Requested spender')).toMatchObject({
    title: recipient
  })
  expect(requestRows.find(row => row.label === 'Requested allowance')).toMatchObject({
    value: '1.5 USDC'
  })
  expect(approve.sections.find(section => section.title === 'Contract data').rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Calldata' })])
  )

  const transfer = reviewCall(`0xa9059cbb${addressWord(recipient)}${word(2_000_000)}`)
  expect(transfer.sections.find(section => section.title === 'Calldata request').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Requested recipient', title: recipient }),
      expect.objectContaining({ label: 'Requested amount', value: '2 USDC' })
    ])
  )
  const transferFrom = reviewCall(
    `0x23b872dd${addressWord(sender)}${addressWord(recipient)}${word(3_000_000)}`
  )
  expect(transferFrom.sections.find(section => section.title === 'Calldata request').rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: 'Requested sender', title: sender }),
      expect.objectContaining({ label: 'Requested recipient', title: recipient })
    ])
  )

  const unlimited = `0x095ea7b3${addressWord(recipient)}${'f'.repeat(64)}`
  expect(
    reviewCall(unlimited)
      .sections.find(section => section.title === 'Calldata request')
      .rows.find(row => row.label === 'Requested allowance').value
  ).toBe('Unlimited')
  for (const calldata of [
    unlimited,
    `0x23b872dd${addressWord(sender)}${addressWord(recipient)}${word(42)}`
  ]) {
    const unknownToken = buildSigningSummaryReviewModel(
      {
        ...original,
        fields: {
          ...original.fields,
          calldata: content('hex', calldata),
          methodSelector: calldata.slice(0, 10)
        }
      },
      { nativeCurrency: options.nativeCurrency }
    )
    expect(unknownToken.sections.some(section => section.title === 'Calldata request')).toBe(false)
    expect(unknownToken.sections[0].rows.find(row => row.label === 'Contract')).toMatchObject({
      title: tokenContract
    })
    expect(unknownToken.sections.find(section => section.title === 'Contract data').rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Calldata', value: calldata })])
    )
  }

  const malformed = [
    `0x095ea7b3${addressWord(recipient)}${word(1)}00`,
    `0x095ea7b3${'f'.repeat(24)}${recipient.slice(2)}${word(1)}`,
    `0x095ea7b3${addressWord(recipient)}${word(1).slice(2)}`
  ]
  for (const calldata of malformed) {
    expect(
      reviewCall(calldata).sections.some(section => section.title === 'Calldata request')
    ).toBe(false)
  }
})

const tronOwner = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const tronReceiver = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'

function tronTransaction(contract, summaryReview = review, overrides = {}) {
  return summary(
    'tron.transaction.v1',
    'tron:0x2b6653dc',
    'transaction',
    {
      signer: tronOwner,
      owner: contract.owner,
      ownerMatchesSigner: contract.owner === tronOwner,
      permissionId: 0,
      transactionId: digest,
      rawData: { byteLength: 128, sha256: digest },
      refBlockBytes: 'abcd',
      refBlockNum: '123',
      refBlockHash: '11'.repeat(8),
      expirationMs: '1700000060000',
      timestampMs: '1700000000000',
      feeLimitSun: '100000000',
      memo: content('utf8', ''),
      existingSigners: [],
      contract,
      ...overrides
    },
    summaryReview
  )
}

const tronContracts = [
  { type: 'transfer', owner: tronOwner, to: tronReceiver, amountSun: '1' },
  {
    type: 'transfer-asset',
    owner: tronOwner,
    to: tronReceiver,
    assetName: content('utf8', '1002000'),
    amountRaw: '2'
  },
  {
    type: 'vote-witness',
    owner: tronOwner,
    votes: [{ voteAddress: tronReceiver, voteCount: '3' }]
  },
  {
    type: 'trigger-smart-contract',
    owner: tronOwner,
    contractAddress: tronReceiver,
    callValueSun: '0',
    callTokenValue: '0',
    tokenId: '0',
    calldata: content('hex', '0xa9059cbb'),
    methodSelector: '0xa9059cbb',
    interpretation: { kind: 'trc20-transfer', to: tronReceiver, amountRaw: '4' }
  },
  { type: 'freeze-balance-v2', owner: tronOwner, resource: 'energy', amountSun: '5' },
  { type: 'unfreeze-balance-v2', owner: tronOwner, resource: 'bandwidth', amountSun: '6' },
  { type: 'withdraw-expire-unfreeze', owner: tronOwner },
  {
    type: 'delegate-resource',
    owner: tronOwner,
    receiver: tronReceiver,
    resource: 'energy',
    amountSun: '7',
    locked: true,
    lockPeriod: '28800'
  },
  {
    type: 'undelegate-resource',
    owner: tronOwner,
    receiver: tronReceiver,
    resource: 'bandwidth',
    amountSun: '8'
  },
  { type: 'cancel-all-unfreeze-v2', owner: tronOwner }
]

test.describe('Signing summary review model', () => {
  test('renders every frozen schema with explicit request and chain rows after the action details', () => {
    const summaries = [
      baseSummaries[0],
      ...baseSummaries.slice(1, 9),
      tronTransaction(tronContracts[0]),
      ...baseSummaries.slice(9)
    ]
    expect(summaries.map(item => item.schema).sort()).toEqual([...SIGNING_SUMMARY_SCHEMAS].sort())

    for (const item of summaries) {
      const model = buildSigningSummaryReviewModel(item)
      expect(model.title.length).toBeGreaterThan(0)
      expect(model.operation).toBe(item.operation)
      expect(model.sections.at(-1)?.rows).toEqual([
        { label: 'Schema', value: item.schema, code: true, breakAll: true },
        { label: 'Chain ID', value: item.chainId, code: true, breakAll: true }
      ])
    }
  })

  test('renders all ten supported TRON contracts without a generic fallback', () => {
    expect(
      tronContracts.map(contract => buildSigningSummaryReviewModel(tronTransaction(contract)).title)
    ).toEqual([
      'Send TRX',
      'Send TRC-10 token',
      'Vote for witnesses',
      'Send TRC-20 token',
      'Freeze TRX',
      'Unfreeze TRX',
      'Withdraw unfrozen TRX',
      'Delegate resources',
      'Undelegate resources',
      'Cancel all unfreezes'
    ])
  })

  test('does not claim a reviewable EVM calldata request is blocked', () => {
    const evmCall = structuredClone(baseSummaries[2])
    evmCall.review = { level: 'caution', issues: [{ code: 'unrecognized-call' }] }
    evmCall.fields.calldata = content('hex', '0x12345678')
    evmCall.fields.methodSelector = '0x12345678'

    const model = buildSigningSummaryReviewModel(evmCall)
    expect(model.level).toBe('caution')
    expect(model.issues[0].description).toContain('Verify the destination and full calldata')
    expect(model.issues[0].description).not.toContain('will not sign')
  })

  test('shows EVM per-gas fees in GWEI without losing fractional precision', () => {
    const evm = structuredClone(baseSummaries[2])
    evm.fields.gasPriceWei = '1500000000'
    evm.fields.maxFeePerGasWei = '2123456789'
    evm.fields.maxPriorityFeePerGasWei = '250000000'

    const rows = buildSigningSummaryReviewModel(evm).sections.flatMap(section => section.rows)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Gas price', value: '1.5 GWEI' }),
        expect.objectContaining({ label: 'Max fee per gas', value: '2.123456789 GWEI' }),
        expect.objectContaining({ label: 'Priority fee per gas', value: '0.25 GWEI' })
      ])
    )
  })

  test('shows Solana total fee, compute unit price, and maximum priority fee', () => {
    const solana = structuredClone(baseSummaries[7])
    solana.fields.feeLamports = '5050'
    solana.fields.computeUnitLimit = '200000'
    solana.fields.computeUnitPriceMicroLamports = '250'
    solana.fields.maximumPriorityFeeLamports = '50'
    solana.fields.simulationStatus = 'succeeded'
    solana.fields.simulationUnitsConsumed = '12345'
    solana.fields.instructions = [
      {
        index: 0,
        programId: 'ComputeBudget111111111111111111111111111111',
        accounts: [],
        data: content('base64', 'AsANAwA='),
        interpretation: { kind: 'compute-unit-limit', units: '200000' }
      },
      {
        index: 1,
        programId: 'ComputeBudget111111111111111111111111111111',
        accounts: [],
        data: content('base64', 'A/oAAAAAAAAA'),
        interpretation: { kind: 'compute-unit-price', microLamports: '250' }
      }
    ]
    const rows = buildSigningSummaryReviewModel(solana).sections.flatMap(section => section.rows)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'RPC total fee', value: '5050 lamports' }),
        expect.objectContaining({ label: 'CU price', value: '250 micro-lamports/CU' }),
        expect.objectContaining({ label: 'Max priority fee', value: '50 lamports' }),
        expect.objectContaining({ label: 'Simulated units', value: '12345' })
      ])
    )
  })

  test('makes approval, permission, multisign, and unknown calldata risks visible', () => {
    const maxAllowance =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const approvalContract = {
      ...tronContracts[3],
      methodSelector: '0x095ea7b3',
      interpretation: { kind: 'trc20-approve', spender: tronReceiver, amountRaw: maxAllowance }
    }
    const caution = buildSigningSummaryReviewModel(
      tronTransaction(
        { ...approvalContract, owner: tronReceiver },
        {
          level: 'caution',
          issues: [
            { code: 'active-permission' },
            { code: 'owner-signer-mismatch' },
            { code: 'multisign' },
            { code: 'token-approval' },
            { code: 'unlimited-token-approval' }
          ]
        },
        { permissionId: 2, existingSigners: [tronReceiver] }
      )
    )
    expect(caution.level).toBe('caution')
    expect(caution.issues.map(issue => issue.title)).toEqual([
      'Unlimited token approval',
      'Token spending approval',
      'Owner and signer differ',
      'TRON active permission',
      'Partially signed transaction'
    ])

    const blocked = buildSigningSummaryReviewModel(
      tronTransaction(
        { ...tronContracts[3], interpretation: { kind: 'unrecognized' } },
        { level: 'blocked', issues: [{ code: 'unrecognized-call' }] }
      )
    )
    expect(blocked.title).toBe('Unknown smart contract call')
    expect(blocked.level).toBe('blocked')
    expect(blocked.issues[0].description).toContain('will not sign')
  })

  test('presents typed-data fields without exposing the internal tagged-value envelope', () => {
    const model = buildSigningSummaryReviewModel(
      summary('evm.typed-data.v1', 'eip155:1', 'message', {
        signer: '0x1111111111111111111111111111111111111111',
        primaryType: 'Message',
        domain: {
          kind: 'struct',
          typeName: 'EIP712Domain',
          fields: [
            {
              name: 'name',
              value: { kind: 'scalar', solidityType: 'string', value: 'Noir Wallet' }
            }
          ]
        },
        message: {
          kind: 'struct',
          typeName: 'Message',
          fields: [
            {
              name: 'contents',
              value: { kind: 'scalar', solidityType: 'string', value: 'Ownership proof' }
            }
          ]
        },
        digestHex: `0x${digest}`
      })
    )

    const typedData = model.sections.find(section => section.title === 'Typed data')
    expect(typedData?.rows).toContainEqual({
      label: 'Domain.name',
      value: 'string · Noir Wallet',
      code: true
    })
    expect(typedData?.rows).toContainEqual({
      label: 'Message.contents',
      value: 'string · Ownership proof',
      code: true
    })
    expect(JSON.stringify(typedData)).not.toContain('"kind":"scalar"')
  })

  test('keeps the renderer independent from runtime, Worker, store, and WASM inputs', () => {
    const source = [
      'signing-summary-review-model.ts',
      'signing-summary-review-model-other.ts',
      'signing-summary-review-model-tron.ts',
      'signing-summary-review-model-types.ts',
      'SigningSummaryReview.tsx'
    ]
      .map(file =>
        readFileSync(
          new URL(`../../../src/popup/components/signing/${file}`, import.meta.url),
          'utf8'
        )
      )
      .join('\n')

    expect(source).not.toMatch(/\bany\b|chrome\.|postMessage|WORKER_RPC|wasm-pkg/i)
    expect(source).not.toMatch(/@\/store|zcash-wallet-runtime/)
    expect(source).toMatch(/disabled=\{isBlocked\}/)
  })
})
