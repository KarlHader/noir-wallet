import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createKeyringCommandSuccess,
  parseKeyringCommand
} from '../../../../src/core/keyring/ports/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { decodeChromeRuntimeCommand } from '../../../../src/infrastructure/keyring/multichain/chrome-runtime-codec.ts'
import { buildSolanaNativeTransfer } from '../../../../src/infrastructure/chains/solana/solana-transaction-builder.ts'
import {
  SolanaRpcError,
  SolanaSimulationError
} from '../../../../src/infrastructure/chains/solana/solana-rpc-types.ts'
import { SolanaMultichainSigningClient } from '../../../../src/infrastructure/keyring/multichain/solana-signing-client.ts'

const chainId = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const systemProgram = '11111111111111111111111111111111'
const keyDomainId = parseKeyDomainId('key-domain:solana-signing-test')
const binding = {
  kind: 'credential',
  keyDomainId,
  credentialGenerationId: 'credential-generation:1',
  globalUnlockEpoch: 'global-unlock:1'
}
const payload = {
  kind: 'solana-transaction',
  chainId,
  accountIndex: 0,
  transaction: 'AQ=='
}

function preparedValue(signingCommandId) {
  const data = Buffer.alloc(12)
  data.writeUInt32LE(2, 0)
  data.writeBigUInt64LE(5_000n, 4)
  return {
    commandId: signingCommandId,
    chainId,
    operation: 'transaction',
    summary: {
      schema: 'solana.transaction.v1',
      chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        messageVersion: 'legacy',
        feePayer: sender,
        recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
        requiredSigners: [sender],
        staticAccountKeys: [sender, recipient, systemProgram],
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
            programId: systemProgram,
            accounts: [
              { address: sender, signer: true, writable: true, source: 'static' },
              { address: recipient, signer: false, writable: true, source: 'static' }
            ],
            data: {
              encoding: 'base64',
              value: data.toString('base64'),
              byteLength: data.length,
              sha256: createHash('sha256').update(data).digest('hex')
            },
            interpretation: {
              kind: 'system-transfer',
              from: sender,
              to: recipient,
              lamports: '5000'
            }
          }
        ]
      }
    },
    payloadFingerprint: { algorithm: 'sha256', digestHex: '1'.repeat(64) },
    execution: { kind: 'internal' },
    expiresAt: 1_800_000_000_000
  }
}

test('uses the credential binding for Solana transaction prepare and confirm', async () => {
  const calls = []
  const client = new SolanaMultichainSigningClient({
    credentials: {
      getCredentialBinding: async requested => (calls.push(['binding', requested]), binding)
    },
    now: () => 1_000,
    createCommandId: (() => {
      let index = 0
      return () => `keyring-command:test:${++index}`
    })(),
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      calls.push([command.operation, command.binding, command.payload])
      if (command.operation === 'signing.prepare') {
        return createKeyringCommandSuccess(
          command.commandId,
          preparedValue('signing-command:solana:1')
        )
      }
      return createKeyringCommandSuccess(command.commandId, {
        kind: 'signed-payload',
        payload: { encoding: 'base64', value: 'AQ==' },
        transactionId: '1'.repeat(64)
      })
    }
  })

  const prepared = await client.prepare(keyDomainId, payload)
  expect(prepared).toMatchObject({
    commandId: 'signing-command:solana:1',
    summary: { schema: 'solana.transaction.v1', review: { level: 'standard' } }
  })
  await expect(
    client.confirm(keyDomainId, parseSigningCommandId('signing-command:solana:1'))
  ).resolves.toEqual({
    kind: 'signed-payload',
    payload: { encoding: 'base64', value: 'AQ==' },
    transactionId: '1'.repeat(64)
  })
  expect(calls).toEqual([
    ['binding', keyDomainId],
    ['signing.prepare', binding, payload],
    ['binding', keyDomainId],
    ['signing.confirm', binding, { signingCommandId: 'signing-command:solana:1' }]
  ])
  await client.destroy()
})

test('rejects a worker response bound to another chain', async () => {
  const client = new SolanaMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:invalid-chain',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      return createKeyringCommandSuccess(command.commandId, {
        ...preparedValue('signing-command:solana:invalid'),
        chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
      })
    }
  })

  await expect(client.prepare(keyDomainId, payload)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  })
  await client.destroy()
})

test('resolves fee, simulation, and lookup context before worker preparation', async () => {
  const built = buildSolanaNativeTransfer({
    chainId,
    sender,
    recipient,
    recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    lamports: '1'
  })
  let workerPayload
  const client = new SolanaMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    rpc: {
      assertExpectedChain: async () => {},
      getAddressLookupTable: async () => {
        throw new Error('legacy transaction must not resolve a lookup table')
      },
      getFeeForMessage: async messageBase64 => {
        expect(messageBase64).toBe(built.messageBase64)
        return { contextSlot: 10, feeLamports: '5000' }
      },
      simulateTransaction: async transactionBase64 => {
        expect(transactionBase64).toBe(built.transactionBase64)
        return { contextSlot: 11, unitsConsumed: 450 }
      }
    },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:solana-rpc-context',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      workerPayload = command.payload
      return createKeyringCommandSuccess(
        command.commandId,
        preparedValue('signing-command:solana:rpc-context')
      )
    }
  })
  await client.prepare(keyDomainId, {
    kind: 'solana-transaction',
    chainId,
    accountIndex: 0,
    transaction: built.transactionBase64
  })
  expect(workerPayload.reviewContext).toEqual({
    messageBase64: built.messageBase64,
    feeLamports: '5000',
    feeContextSlot: 10,
    simulationUnitsConsumed: '450',
    simulationStatus: 'succeeded',
    simulationContextSlot: 11,
    lookupTables: []
  })
  await client.destroy()
})

test('preserves a failed simulation as a review warning context', async () => {
  const built = buildSolanaNativeTransfer({
    chainId,
    sender,
    recipient,
    recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    lamports: '1'
  })
  let workerPayload
  const client = new SolanaMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    rpc: {
      assertExpectedChain: async () => {},
      getAddressLookupTable: async () => null,
      getFeeForMessage: async () => ({ contextSlot: 10, feeLamports: '5000' }),
      simulateTransaction: async () => {
        throw new SolanaSimulationError(11, 300)
      }
    },
    createCommandId: () => 'keyring-command:solana-failed-simulation',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      workerPayload = command.payload
      return createKeyringCommandSuccess(
        command.commandId,
        preparedValue('signing-command:solana:failed-simulation')
      )
    }
  })
  await client.prepare(keyDomainId, {
    kind: 'solana-transaction',
    chainId,
    accountIndex: 0,
    transaction: built.transactionBase64
  })
  expect(workerPayload.reviewContext).toMatchObject({
    simulationStatus: 'failed',
    simulationUnitsConsumed: null,
    simulationContextSlot: 11
  })
  await client.destroy()
})

test('fails closed when the simulation RPC itself is unavailable', async () => {
  const built = buildSolanaNativeTransfer({
    chainId,
    sender,
    recipient,
    recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    lamports: '1'
  })
  let forwarded = false
  const client = new SolanaMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    rpc: {
      assertExpectedChain: async () => {},
      getAddressLookupTable: async () => null,
      getFeeForMessage: async () => ({ contextSlot: 10, feeLamports: '5000' }),
      simulateTransaction: async () => {
        throw new SolanaRpcError('network-unavailable', 'Solana RPC endpoint is unavailable')
      }
    },
    forward: async () => {
      forwarded = true
      throw new Error('must not forward an unreviewed transaction')
    }
  })
  await expect(
    client.prepare(keyDomainId, {
      kind: 'solana-transaction',
      chainId,
      accountIndex: 0,
      transaction: built.transactionBase64
    })
  ).rejects.toMatchObject({ code: 'network-unavailable' })
  expect(forwarded).toBe(false)
  await client.destroy()
})

test('prepares and confirms a Solana lending identity message signature', async () => {
  const message = new TextEncoder().encode('lending identity')
  const messageValue = 'lending identity'
  const client = new SolanaMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:solana-message',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      if (command.operation === 'signing.prepare') {
        return createKeyringCommandSuccess(command.commandId, {
          commandId: 'signing-command:solana:message',
          chainId,
          operation: 'message',
          summary: {
            schema: 'solana.message.v1',
            chainId,
            operation: 'message',
            review: { level: 'standard', issues: [] },
            fields: {
              signer: sender,
              domain: 'solana:raw-message',
              message: {
                encoding: 'utf8',
                value: messageValue,
                byteLength: message.length,
                sha256: createHash('sha256').update(message).digest('hex')
              }
            }
          },
          payloadFingerprint: {
            algorithm: 'sha256',
            digestHex: createHash('sha256').update(message).digest('hex')
          },
          execution: { kind: 'internal' },
          expiresAt: 1_800_000_000_000
        })
      }
      return createKeyringCommandSuccess(command.commandId, {
        kind: 'signature',
        signature: { encoding: 'utf8', value: '1'.repeat(64) },
        publicKey: sender,
        address: sender
      })
    }
  })

  const prepared = await client.prepare(keyDomainId, {
    kind: 'solana-message',
    chainId,
    accountIndex: 0,
    message
  })
  expect(prepared).toMatchObject({ operation: 'message', summary: { schema: 'solana.message.v1' } })
  await expect(client.confirm(keyDomainId, prepared.commandId)).resolves.toEqual({
    kind: 'signature',
    signature: { encoding: 'utf8', value: '1'.repeat(64) },
    publicKey: sender,
    address: sender
  })
  await client.destroy()
})
