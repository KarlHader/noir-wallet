import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  isTrustedRuntimeMessageSender,
  parseTrustedExtensionRuntimeMessage
} from '../../../src/lib/runtime-message-security.ts'

test.describe('dApp execution mode runtime messages', () => {
  test('accepts only exact extension-page mode requests', () => {
    expect(parseTrustedExtensionRuntimeMessage({ type: 'GET_DAPP_EXECUTION_MODE' })).toEqual({
      type: 'GET_DAPP_EXECUTION_MODE'
    })
    expect(
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_DAPP_EXECUTION_MODE',
        mode: 'private',
        confirmPrivateSetup: true,
        confirmAffectedOperations: true
      })
    ).toEqual({
      type: 'SET_DAPP_EXECUTION_MODE',
      mode: 'private',
      confirmPrivateSetup: true,
      confirmAffectedOperations: true
    })

    expect(() =>
      parseTrustedExtensionRuntimeMessage({ type: 'SET_DAPP_EXECUTION_MODE', mode: 'hidden' })
    ).toThrow('Invalid trusted runtime message schema')
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_DAPP_EXECUTION_MODE',
        mode: 'main',
        keyDomainId: 'attacker-selected-wallet'
      })
    ).toThrow('Invalid trusted runtime message schema')
    expect(() =>
      parseTrustedExtensionRuntimeMessage({
        type: 'SET_DAPP_EXECUTION_MODE',
        mode: 'main',
        confirmAffectedOperations: 'yes'
      })
    ).toThrow('Invalid trusted runtime message schema')
  })

  test('isolates scoped Incognito setup from dApp and execution mode requests', () => {
    const scope = { network: 'mainnet', keyDomainId: 'wallet-1', accountId: 'account-2' }
    const read = { type: 'GET_ACCOUNT_INCOGNITO_SETUP', scope }
    const complete = { type: 'COMPLETE_ACCOUNT_INCOGNITO_SETUP', scope, confirmPrivateSetup: true }
    const extensionId = 'test-extension'
    for (const message of [read, complete]) {
      expect(parseTrustedExtensionRuntimeMessage(message)).toEqual(message)
      expect(
        isTrustedRuntimeMessageSender(
          message.type,
          { id: extensionId, url: `chrome-extension://${extensionId}/index.html` },
          extensionId
        )
      ).toBe(true)
      expect(
        isTrustedRuntimeMessageSender(
          message.type,
          { id: extensionId, url: 'https://dapp.example/', tab: { id: 1 } },
          extensionId
        )
      ).toBe(false)
    }
    for (const message of [
      { type: complete.type, scope },
      { ...complete, confirmPrivateSetup: false },
      { ...complete, mode: 'private' },
      { ...read, scope: { ...scope, network: 'unknown' } },
      { ...read, scope: { ...scope, accountId: '' } }
    ]) {
      expect(() => parseTrustedExtensionRuntimeMessage(message)).toThrow(
        'Invalid trusted runtime message schema'
      )
    }
  })
})
