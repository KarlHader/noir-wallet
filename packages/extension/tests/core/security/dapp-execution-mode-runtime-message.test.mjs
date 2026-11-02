import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseTrustedExtensionRuntimeMessage } from '../../../src/lib/runtime-message-security.ts'

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
})
