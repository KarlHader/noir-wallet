import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createKeyringCommandSuccess,
  parseKeyringCommand
} from '../../../../src/core/keyring/ports/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { decodeChromeRuntimeCommand } from '../../../../src/infrastructure/keyring/multichain/chrome-runtime-codec.ts'
import { EvmMultichainSigningClient } from '../../../../src/infrastructure/keyring/multichain/evm-signing-client.ts'

const chainId = 'eip155:1'
const keyDomainId = parseKeyDomainId('key-domain:evm-signing-test')
const binding = {
  kind: 'credential',
  keyDomainId,
  credentialGenerationId: 'credential-generation:1',
  globalUnlockEpoch: 'global-unlock:1'
}
const payload = {
  kind: 'evm-transaction',
  chainId,
  addressIndex: 0,
  transaction: {
    type: 'eip1559',
    chainId: '1',
    nonce: '7',
    maxFeePerGas: '5000000000',
    maxPriorityFeePerGas: '1000000000',
    gasLimit: '21000',
    to: '0x2222222222222222222222222222222222222222',
    value: '123',
    input: '0x',
    accessList: []
  }
}

function preparedValue(signingCommandId) {
  return {
    commandId: signingCommandId,
    chainId,
    operation: 'transaction',
    summary: {
      schema: 'evm.transaction.v1',
      chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        transactionType: 'eip1559',
        from: '0x1111111111111111111111111111111111111111',
        to: payload.transaction.to,
        nonce: '7',
        valueWei: '123',
        gasLimit: '21000',
        maximumFeeWei: '105000000000000',
        gasPriceWei: null,
        maxFeePerGasWei: '5000000000',
        maxPriorityFeePerGasWei: '1000000000',
        accessList: [],
        calldata: {
          encoding: 'hex',
          value: '0x',
          byteLength: 0,
          sha256: '0'.repeat(64)
        },
        methodSelector: null
      }
    },
    payloadFingerprint: { algorithm: 'sha256', digestHex: '1'.repeat(64) },
    execution: { kind: 'internal' },
    expiresAt: 1_800_000_000_000
  }
}

test('uses the attested credential binding for Background-only EVM prepare and confirm', async () => {
  const calls = []
  let signingCommandId
  const client = new EvmMultichainSigningClient({
    credentials: {
      getCredentialBinding: async requested => {
        calls.push(['binding', requested])
        return binding
      }
    },
    now: () => 1_000,
    createCommandId: (() => {
      let index = 0
      return () => `keyring-command:test:${++index}`
    })(),
    forward: async (method, forwardedPayload) => {
      expect(method).toBe('multichain.execute')
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      calls.push([command.operation, command.binding, command.payload])
      if (command.operation === 'signing.prepare') {
        signingCommandId = 'signing-command:evm:1'
        return createKeyringCommandSuccess(command.commandId, preparedValue(signingCommandId))
      }
      if (command.operation === 'signing.confirm') {
        return createKeyringCommandSuccess(command.commandId, {
          kind: 'signed-payload',
          payload: { encoding: 'hex', value: '0x1234' },
          transactionId: `0x${'2'.repeat(64)}`
        })
      }
      throw new Error(`Unexpected operation: ${command.operation}`)
    }
  })

  const prepared = await client.prepare(keyDomainId, payload)
  expect(prepared).toMatchObject({
    commandId: signingCommandId,
    chainId,
    operation: 'transaction',
    execution: { kind: 'internal' },
    summary: { schema: 'evm.transaction.v1' }
  })
  const signed = await client.confirm(keyDomainId, parseSigningCommandId(signingCommandId))
  expect(signed).toEqual({
    kind: 'signed-payload',
    payload: { encoding: 'hex', value: '0x1234' },
    transactionId: `0x${'2'.repeat(64)}`
  })
  expect(calls).toEqual([
    ['binding', keyDomainId],
    ['signing.prepare', binding, payload],
    ['binding', keyDomainId],
    ['signing.confirm', binding, { signingCommandId: 'signing-command:evm:1' }]
  ])
  await client.destroy()
})

test('rejects a worker response whose prepared summary is bound to another chain', async () => {
  const client = new EvmMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:invalid-chain',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      return createKeyringCommandSuccess(command.commandId, {
        ...preparedValue('signing-command:evm:invalid'),
        chainId: 'eip155:11155111'
      })
    }
  })

  await expect(client.prepare(keyDomainId, payload)).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  })
  await client.destroy()
})
