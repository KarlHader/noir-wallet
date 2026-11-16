import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { buildSolanaNativeTransfer } from '../../../../src/infrastructure/chains/solana/solana-transaction-builder.ts'
import { encodeSolanaBase58 } from '../../../../src/infrastructure/chains/solana/solana-rpc-codecs.ts'
import { adaptSolanaPreparedSigning } from '../../../../src/infrastructure/keyring/multichain/signing-adapter-solana.ts'

const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const computeProgram = 'ComputeBudget111111111111111111111111111111'
const systemProgram = '11111111111111111111111111111111'
const built = buildSolanaNativeTransfer({
  chainId,
  sender,
  recipient: 'SysvarRent111111111111111111111111111111111',
  recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
  lamports: '1'
})

function computeData(discriminator, value, bytes) {
  const data = Buffer.alloc(1 + bytes)
  data[0] = discriminator
  if (bytes === 4) data.writeUInt32LE(Number(value), 1)
  else data.writeBigUInt64LE(BigInt(value), 1)
  return data.toString('base64')
}

function rawPrepared() {
  return {
    requestId: 1,
    account: {
      accountId: `${chainId}:${sender}`,
      address: sender,
      derivationPath: "m/44'/501'/0'/0'",
      publicKey: sender,
      curve: 'ed25519',
      addressScheme: 'solana',
      derivationScheme: 'slip10'
    },
    messageHash: '11'.repeat(32),
    summary: {
      chainId,
      version: 'legacy',
      signer: sender,
      signerIndex: 0,
      feePayer: sender,
      recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
      requiredSignatures: 1,
      readonlySignedAccounts: 0,
      readonlyUnsignedAccounts: 2,
      existingSignatureIndexes: [],
      staticAccountKeys: [sender, computeProgram, systemProgram],
      instructions: [
        {
          programIdIndex: 1,
          programId: computeProgram,
          accountIndexes: [],
          data: computeData(2, 200_000, 4)
        },
        {
          programIdIndex: 1,
          programId: computeProgram,
          accountIndexes: [],
          data: computeData(3, 250, 8)
        },
        {
          programIdIndex: 2,
          programId: systemProgram,
          accountIndexes: [],
          data: 'AQ=='
        }
      ],
      addressTableLookups: []
    }
  }
}

const reviewContext = {
  messageBase64: built.messageBase64,
  feeLamports: '5050',
  feeContextSlot: 10,
  simulationUnitsConsumed: '12345',
  simulationStatus: 'succeeded',
  simulationContextSlot: 11,
  lookupTables: []
}

test('decodes Solana compute budget fees and cautions for an unknown program instruction', async () => {
  const adapted = await adaptSolanaPreparedSigning(
    rawPrepared(),
    {
      kind: 'solana-transaction',
      chainId,
      accountIndex: 0,
      transaction: built.transactionBase64,
      reviewContext
    },
    parseSigningCommandId('signing-command:solana:compute-budget'),
    Date.now() + 60_000,
    false
  )
  expect(adapted.prepared.summary).toMatchObject({
    review: {
      level: 'caution',
      issues: [{ code: 'unrecognized-instruction', subjectIndex: 2 }]
    },
    fields: {
      feeLamports: '5050',
      computeUnitLimit: '200000',
      computeUnitPriceMicroLamports: '250',
      maximumPriorityFeeLamports: '50',
      simulationUnitsConsumed: '12345',
      instructions: [
        { interpretation: { kind: 'compute-unit-limit', units: '200000' } },
        { interpretation: { kind: 'compute-unit-price', microLamports: '250' } },
        { interpretation: { kind: 'unrecognized' } }
      ]
    }
  })
})

test('rejects a fee quote bound to different Solana message bytes', async () => {
  await expect(
    adaptSolanaPreparedSigning(
      rawPrepared(),
      {
        kind: 'solana-transaction',
        chainId,
        accountIndex: 0,
        transaction: built.transactionBase64,
        reviewContext: { ...reviewContext, messageBase64: 'AQ==' }
      },
      parseSigningCommandId('signing-command:solana:wrong-fee-message'),
      Date.now() + 60_000,
      false
    )
  ).rejects.toThrow(/different transaction message/)
})

test('preserves a failed simulation as an explicit review warning', async () => {
  const adapted = await adaptSolanaPreparedSigning(
    rawPrepared(),
    {
      kind: 'solana-transaction',
      chainId,
      accountIndex: 0,
      transaction: built.transactionBase64,
      reviewContext: {
        ...reviewContext,
        simulationStatus: 'failed',
        simulationUnitsConsumed: null
      }
    },
    parseSigningCommandId('signing-command:solana:failed-simulation'),
    Date.now() + 60_000,
    false
  )
  expect(adapted.prepared.summary).toMatchObject({
    review: {
      level: 'caution',
      issues: [{ code: 'unrecognized-instruction', subjectIndex: 2 }, { code: 'simulation-failed' }]
    },
    fields: {
      simulationStatus: 'failed',
      simulationUnitsConsumed: null
    }
  })
})

test('resolves v0 lookup accounts before interpreting instructions', async () => {
  const tableBytes = Uint8Array.from({ length: 32 }, () => 7)
  const tableKey = encodeSolanaBase58(tableBytes)
  const transferData = Buffer.alloc(12)
  transferData.writeUInt32LE(2, 0)
  transferData.writeBigUInt64LE(9n, 4)
  const message = Buffer.concat([
    Buffer.from([0x80, 1, 0, 0, 1]),
    Buffer.alloc(32),
    Buffer.alloc(32),
    Buffer.from([1, 2, 2, 0, 1, transferData.length]),
    transferData,
    Buffer.from([1]),
    Buffer.from(tableBytes),
    Buffer.from([1, 1, 1, 3])
  ])
  const transactionBase64 = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString(
    'base64'
  )
  const raw = rawPrepared()
  raw.summary.version = 'v0'
  raw.summary.staticAccountKeys = [sender]
  raw.summary.readonlyUnsignedAccounts = 0
  raw.summary.instructions = [
    {
      programIdIndex: 2,
      programId: systemProgram,
      accountIndexes: [0, 1],
      data: transferData.toString('base64')
    }
  ]
  raw.summary.addressTableLookups = [
    { accountKey: tableKey, writableIndexes: [1], readonlyIndexes: [3] }
  ]
  const adapted = await adaptSolanaPreparedSigning(
    raw,
    {
      kind: 'solana-transaction',
      chainId,
      accountIndex: 0,
      transaction: transactionBase64,
      reviewContext: {
        messageBase64: message.toString('base64'),
        feeLamports: '5000',
        feeContextSlot: 20,
        simulationUnitsConsumed: '800',
        simulationStatus: 'succeeded',
        simulationContextSlot: 21,
        lookupTables: [
          {
            accountKey: tableKey,
            contextSlot: 19,
            addresses: [
              sender,
              'SysvarRent111111111111111111111111111111111',
              sender,
              systemProgram
            ]
          }
        ]
      }
    },
    parseSigningCommandId('signing-command:solana:v0-lookup'),
    Date.now() + 60_000,
    false
  )
  expect(adapted.prepared.summary).toMatchObject({
    review: { level: 'standard' },
    fields: {
      messageVersion: 'v0',
      addressTableLookups: [
        {
          accountKey: tableKey,
          writableAddresses: ['SysvarRent111111111111111111111111111111111'],
          readonlyAddresses: [systemProgram]
        }
      ],
      instructions: [
        {
          programId: systemProgram,
          accounts: [
            { address: sender, source: 'static', signer: true, writable: true },
            {
              address: 'SysvarRent111111111111111111111111111111111',
              source: 'lookup',
              signer: false,
              writable: true
            }
          ],
          interpretation: {
            kind: 'system-transfer',
            from: sender,
            to: 'SysvarRent111111111111111111111111111111111',
            lamports: '9'
          }
        }
      ]
    }
  })
})
