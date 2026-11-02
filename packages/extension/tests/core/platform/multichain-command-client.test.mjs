import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  KEYRING_COMMAND_PROTOCOL_VERSION,
  KeyringError,
  createKeyringCommandFailure,
  createKeyringCommandSuccess
} from '../../../src/core/keyring/ports/index.ts'
import { MultichainCommandClient } from '../../../src/infrastructure/keyring/multichain/command-client.ts'
import { MockKeyringTransport } from '../../helpers/mock-keyring-transport.ts'

const UNBOUND_BINDING = Object.freeze({ kind: 'unbound' })
const CREDENTIAL_BINDING = Object.freeze({
  kind: 'credential',
  keyDomainId: 'key-domain:1',
  credentialGenerationId: 'credential-generation:1',
  globalUnlockEpoch: 'global-unlock:1'
})

function commandRequest(operation, payload = {}, options = {}) {
  return {
    operation,
    binding: operation === 'capabilities.get' ? UNBOUND_BINDING : CREDENTIAL_BINDING,
    payload,
    ...options
  }
}

function parseAddress(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 1 ||
    typeof value.address !== 'string'
  ) {
    throw new Error('Invalid address result')
  }
  return { address: value.address }
}

function createClient(handler, options = {}) {
  const transport = new MockKeyringTransport(handler)
  const client = new MultichainCommandClient(transport, {
    now: () => 1_000,
    createCommandId: () => 'keyring-command:test',
    ...options
  })
  return { client, transport }
}

test.describe('multichain command client', () => {
  test('supports credential creation and import while rejecting passphrase fields', async () => {
    const { client, transport } = createClient(command =>
      createKeyringCommandSuccess(command.commandId, { vault: 'encrypted' })
    )

    await expect(
      client.execute(
        commandRequest('credential.import', {
          mnemonic: 'test test test test test test test test test test test junk',
          password: 'test-password'
        }),
        value => value
      )
    ).resolves.toEqual({ vault: 'encrypted' })
    expect(transport.commands[0].operation).toBe('credential.import')

    await expect(
      client.execute(
        commandRequest('credential.create', {
          wordCount: 12,
          password: 'test-password'
        }),
        value => value
      )
    ).resolves.toEqual({ vault: 'encrypted' })

    await expect(
      client.execute(
        commandRequest('credential.import', {
          mnemonic: 'test test test test test test test test test test test junk',
          password: 'test-password',
          bip39Passphrase: 'must-not-pass'
        }),
        value => value
      )
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
  })

  test('builds a product command, copies payload bytes, and parses a correlated result', async () => {
    const payloadBytes = new Uint8Array([1, 2, 3])
    const { client, transport } = createClient(command =>
      createKeyringCommandSuccess(command.commandId, {
        address: '0x1234'
      })
    )

    const resultPromise = client.execute(
      commandRequest('account.derive-public', {
        keyDomainId: 'key-domain:1',
        payloadBytes
      }),
      parseAddress
    )
    payloadBytes[0] = 9

    await expect(resultPromise).resolves.toEqual({ address: '0x1234' })
    expect(transport.commands).toHaveLength(1)
    expect(transport.commands[0]).toMatchObject({
      protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
      commandId: 'keyring-command:test',
      engine: 'multichain',
      operation: 'account.derive-public',
      binding: CREDENTIAL_BINDING,
      deadlineAt: 31_000
    })
    expect(transport.commands[0].payload.payloadBytes).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('surfaces stable engine errors and rejects forged response correlation', async () => {
    const failure = createClient(command =>
      createKeyringCommandFailure(command.commandId, 'CREDENTIAL_LOCKED')
    )
    await expect(
      failure.client.execute(commandRequest('credential.get-state'), value => value)
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_LOCKED',
      retry: 'after-unlock'
    })

    const forged = createClient(() => ({
      protocolVersion: KEYRING_COMMAND_PROTOCOL_VERSION,
      commandId: 'keyring-command:forged',
      ok: true,
      value: { address: '0x1234' }
    }))
    await expect(
      forged.client.execute(commandRequest('account.derive-public'), parseAddress)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  test('fails closed on timeout, caller cancellation, capacity, and destroy', async () => {
    const never = () => new Promise(() => {})
    const timed = createClient(never, {
      defaultTimeoutMs: 10,
      maxTimeoutMs: 50
    })
    await expect(
      timed.client.execute(commandRequest('capabilities.get'), value => value)
    ).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' })

    const cancelled = createClient(never)
    const abortController = new AbortController()
    const cancelledRequest = cancelled.client.execute(
      commandRequest('signing.prepare', {}, { signal: abortController.signal }),
      value => value
    )
    abortController.abort()
    await expect(cancelledRequest).rejects.toMatchObject({
      code: 'SIGNING_COMMAND_CANCELLED'
    })

    const capacity = createClient(never, { maxPendingCommands: 1 })
    const first = capacity.client.execute(commandRequest('capabilities.get'), value => value)
    await expect(
      capacity.client.execute(commandRequest('capabilities.get'), value => value)
    ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
    await capacity.client.destroy()
    await expect(first).rejects.toMatchObject({
      code: 'SIGNING_COMMAND_CANCELLED'
    })
    await expect(
      capacity.client.execute(commandRequest('capabilities.get'), value => value)
    ).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' })
  })

  test('rejects raw engine handles and normalizes unknown transport errors', async () => {
    const raw = createClient(command => createKeyringCommandSuccess(command.commandId, null))
    await expect(
      raw.client.execute(
        commandRequest('signing.confirm', { requestId: 'raw-wasm-request' }),
        value => value
      )
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' })

    const secret = 'seed phrase abandon abandon abandon'
    const unknown = createClient(() => {
      throw new Error(secret)
    })
    let error
    try {
      await unknown.client.execute(commandRequest('capabilities.get'), value => value)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(KeyringError)
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', retry: 'never' })
    expect(error.message).not.toContain(secret)
  })

  test('rejects malformed public requests and command identifiers', async () => {
    const invalid = createClient(command => createKeyringCommandSuccess(command.commandId, null))

    await expect(invalid.client.execute(null, value => value)).rejects.toMatchObject({
      code: 'INVALID_COMMAND'
    })
    await expect(
      invalid.client.execute(
        {
          operation: 'capabilities.get',
          binding: UNBOUND_BINDING,
          payload: {},
          unexpected: true
        },
        value => value
      )
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    await expect(
      invalid.client.execute({ operation: 'capabilities.get', payload: {} }, value => value)
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' })

    const invalidId = createClient(
      command => createKeyringCommandSuccess(command.commandId, null),
      { createCommandId: () => null }
    )
    await expect(
      invalidId.client.execute(commandRequest('capabilities.get'), value => value)
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
  })
})
