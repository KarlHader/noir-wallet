import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createKeyringCommandSuccess,
  parseKeyringCommand
} from '../../../../src/core/keyring/ports/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import { parseSigningCommandId } from '../../../../src/core/keyring/ports/index.ts'
import { decodeChromeRuntimeCommand } from '../../../../src/infrastructure/keyring/multichain/chrome-runtime-codec.ts'
import { BitcoinMultichainSigningClient } from '../../../../src/infrastructure/keyring/multichain/bitcoin-signing-client.ts'

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const keyDomainId = parseKeyDomainId('key-domain:bitcoin-signing-test')
const binding = {
  kind: 'credential',
  keyDomainId,
  credentialGenerationId: 'credential-generation:1',
  globalUnlockEpoch: 'global-unlock:1'
}
const payload = {
  kind: 'bitcoin-psbt',
  chainId,
  addressType: 'p2wpkh',
  accountIndex: 0,
  psbt: 'cHNidP8='
}
const transactionId = 'a'.repeat(64)

function preparedValue(signingCommandId) {
  return {
    commandId: signingCommandId,
    chainId,
    operation: 'transaction',
    summary: {
      schema: 'bitcoin.psbt.v1',
      chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        psbtVersion: 0,
        signer: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
        inputs: [
          {
            index: 0,
            transactionId: 'a'.repeat(64),
            outputIndex: 0,
            amountSats: '1000',
            sequence: 0xfffffffd,
            scriptType: 'p2wpkh',
            sighashType: 'SIGHASH_ALL',
            ownership: 'signing-account'
          }
        ],
        outputs: [
          {
            index: 0,
            address: 'bc1q9e62r7td7yp6tw2aeqt3u2h5sd0q8r72f2c9aj',
            scriptPubKeyHex: '0x00142e74a1f96df103a5b95dc8171e2af4835e038fca',
            amountSats: '900',
            classification: 'recipient'
          }
        ],
        signingInputIndexes: [0],
        totalInputSats: '1000',
        totalOutputSats: '900',
        feeSats: '100'
      }
    },
    payloadFingerprint: { algorithm: 'sha256', digestHex: '1'.repeat(64) },
    execution: { kind: 'internal' },
    expiresAt: 1_800_000_000_000
  }
}

test('uses the attested credential binding for Background-only Bitcoin prepare and confirm', async () => {
  const calls = []
  let signingCommandId
  const client = new BitcoinMultichainSigningClient({
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
        signingCommandId = 'signing-command:bitcoin:1'
        return createKeyringCommandSuccess(command.commandId, preparedValue(signingCommandId))
      }
      if (command.operation === 'signing.confirm') {
        return createKeyringCommandSuccess(command.commandId, {
          kind: 'signed-payload',
          payload: { encoding: 'base64', value: 'cHNidP8=' },
          transactionId
        })
      }
      throw new Error(`Unexpected operation: ${command.operation}`)
    }
  })

  await expect(client.prepare(keyDomainId, payload)).resolves.toMatchObject({
    commandId: 'signing-command:bitcoin:1',
    chainId,
    operation: 'transaction',
    execution: { kind: 'internal' },
    summary: { schema: 'bitcoin.psbt.v1' }
  })
  await expect(
    client.confirm(keyDomainId, parseSigningCommandId(signingCommandId))
  ).resolves.toEqual({
    kind: 'signed-payload',
    payload: { encoding: 'base64', value: 'cHNidP8=' },
    transactionId
  })
  expect(calls).toEqual([
    ['binding', keyDomainId],
    ['signing.prepare', binding, payload],
    ['binding', keyDomainId],
    ['signing.confirm', binding, { signingCommandId: 'signing-command:bitcoin:1' }]
  ])
  await client.destroy()
})

test('rejects wrong-chain summaries and non-canonical signed Bitcoin results', async () => {
  for (const response of [
    { ...preparedValue('signing-command:bitcoin:invalid'), chainId: 'eip155:1' },
    {
      kind: 'signed-payload',
      payload: { encoding: 'hex', value: '0x1234' },
      transactionId
    },
    {
      kind: 'signed-payload',
      payload: { encoding: 'base64', value: 'cHNidP8=' },
      transactionId: transactionId.toUpperCase()
    }
  ]) {
    const client = new BitcoinMultichainSigningClient({
      credentials: { getCredentialBinding: async () => binding },
      now: () => 1_000,
      createCommandId: () => 'keyring-command:invalid',
      forward: async (_method, forwardedPayload) => {
        const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
        return createKeyringCommandSuccess(command.commandId, response)
      }
    })

    if ('commandId' in response) {
      await expect(client.prepare(keyDomainId, payload)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    } else {
      await expect(
        client.confirm(keyDomainId, parseSigningCommandId('signing-command:bitcoin:invalid'))
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
    await client.destroy()
  }
})

test('parses a BIP-322 prepared command and account-bound signature result', async () => {
  const messagePayload = {
    kind: 'bitcoin-bip322-message',
    chainId,
    addressType: 'p2wpkh',
    accountIndex: 0,
    change: false,
    addressIndex: 0,
    message: new TextEncoder().encode('Noir Bitcoin proof')
  }
  const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
  const publicKey = `0x02${'22'.repeat(32)}`
  const client = new BitcoinMultichainSigningClient({
    credentials: { getCredentialBinding: async () => binding },
    now: () => 1_000,
    createCommandId: () => 'keyring-command:bitcoin-message',
    forward: async (_method, forwardedPayload) => {
      const command = parseKeyringCommand(decodeChromeRuntimeCommand(forwardedPayload.command))
      if (command.operation === 'signing.prepare') {
        return createKeyringCommandSuccess(command.commandId, {
          commandId: 'signing-command:bitcoin-message',
          chainId,
          operation: 'message',
          summary: {
            schema: 'bitcoin.bip322-message.v1',
            chainId,
            operation: 'message',
            review: { level: 'standard', issues: [] },
            fields: {
              address,
              message: {
                encoding: 'utf8',
                value: 'Noir Bitcoin proof',
                byteLength: 18,
                sha256: '00'.repeat(32)
              }
            }
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: '2'.repeat(64) },
          execution: { kind: 'internal' },
          expiresAt: 1_800_000_000_000
        })
      }
      return createKeyringCommandSuccess(command.commandId, {
        kind: 'signature',
        signature: { encoding: 'utf8', value: 'smp-noir-signature' },
        publicKey,
        address
      })
    }
  })

  const prepared = await client.prepare(keyDomainId, messagePayload)
  expect(prepared).toMatchObject({
    operation: 'message',
    summary: { schema: 'bitcoin.bip322-message.v1', fields: { address } }
  })
  await expect(client.confirm(keyDomainId, prepared.commandId)).resolves.toEqual({
    kind: 'signature',
    signature: { encoding: 'utf8', value: 'smp-noir-signature' },
    publicKey,
    address
  })
  await client.destroy()
})
