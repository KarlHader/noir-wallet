import { test } from 'node:test'
import { expect } from '@playwright/test'

import { authorizeMultichainExtensionCommand } from '../../../../src/background/multichain-rpc-policy.ts'

function command(operation, payload = {}) {
  const binding =
    operation === 'capabilities.get' || operation === 'signing.verify'
      ? { kind: 'unbound' }
      : operation === 'credential.lock-all'
        ? { kind: 'global', globalUnlockEpoch: 'global-unlock:rpc-policy' }
        : {
            kind: 'credential',
            keyDomainId: 'key-domain:rpc-policy',
            credentialGenerationId: 'credential-generation:rpc-policy',
            globalUnlockEpoch: 'global-unlock:rpc-policy'
          }
  return {
    protocolVersion: 2,
    commandId: `keyring-command:rpc-policy:${operation}`,
    engine: 'multichain',
    operation,
    binding,
    deadlineAt: Date.now() + 60_000,
    payload
  }
}

test.describe('Multichain extension-page RPC policy', () => {
  test('allows only canonical mnemonic creation through the extension-page route', () => {
    expect(
      authorizeMultichainExtensionCommand(
        command('credential.create', { wordCount: 24, password: 'test-password' })
      )
    ).toEqual({ allowed: true })
  })

  test('keeps derive, signing, credential session and capability commands Background-only', () => {
    for (const operation of [
      'capabilities.get',
      'credential.import',
      'credential.import-private-key',
      'credential.export-private-key',
      'credential.rewrap-private-key',
      'credential.unlock',
      'credential.lock',
      'credential.lock-all',
      'credential.get-state',
      'account.derive-public',
      'signing.prepare',
      'signing.confirm',
      'signing.verify',
      'signing.cancel',
      'signing.cancel-all',
      'command.cancel'
    ]) {
      expect(authorizeMultichainExtensionCommand(command(operation))).toEqual({
        allowed: false,
        reason: 'background-only'
      })
    }
  })

  test('rejects malformed and encoded-binary commands before policy evaluation', () => {
    expect(authorizeMultichainExtensionCommand({ operation: 'credential.create' })).toEqual({
      allowed: false,
      reason: 'invalid-command'
    })
    expect(
      authorizeMultichainExtensionCommand({
        ...command('credential.create', { wordCount: 24, password: 'test-password' }),
        unexpected: true
      })
    ).toEqual({ allowed: false, reason: 'invalid-command' })
  })
})
