import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  DAppExecutionModeClientError,
  createDAppExecutionModeClient
} from '../../../src/popup/services/dapp-execution-mode-client.ts'

const privateState = Object.freeze({
  mode: 'private',
  privateAvailable: true,
  privateSetupCompleted: true
})

test.describe('dApp execution mode Popup client', () => {
  test('reads and changes the active account mode without accepting a caller-selected scope', async () => {
    const messages = []
    const client = createDAppExecutionModeClient(async message => {
      messages.push(message)
      return { success: true, state: privateState }
    })

    await expect(client.read()).resolves.toEqual(privateState)
    await expect(
      client.set('private', {
        confirmPrivateSetup: true,
        confirmAffectedOperations: true
      })
    ).resolves.toEqual(privateState)
    expect(messages).toEqual([
      { type: 'GET_DAPP_EXECUTION_MODE' },
      {
        type: 'SET_DAPP_EXECUTION_MODE',
        mode: 'private',
        confirmPrivateSetup: true,
        confirmAffectedOperations: true
      }
    ])
  })

  test('preserves a validated affected-operation impact for a confirmation retry', async () => {
    const client = createDAppExecutionModeClient(async () => ({
      error: '2 pending dApp operations require confirmation before changing account mode',
      code: 'affected-operations-confirmation-required',
      impact: { pendingApprovalCount: 2 }
    }))

    await expect(client.set('main')).rejects.toMatchObject({
      code: 'affected-operations-confirmation-required',
      impact: { pendingApprovalCount: 2 }
    })
  })

  test('preserves a bounded Background failure and rejects malformed success data', async () => {
    await expect(
      createDAppExecutionModeClient(async () => ({
        error: 'Private Execution Address is unavailable in this wallet build'
      })).set('private')
    ).rejects.toMatchObject({
      code: 'request-failed',
      message: 'Private Execution Address is unavailable in this wallet build'
    })

    for (const response of [
      null,
      { success: true },
      {
        error: 'confirm',
        code: 'affected-operations-confirmation-required',
        impact: { pendingApprovalCount: 0 }
      },
      { success: true, state: { ...privateState, address: '0xsecret' } },
      { success: true, state: { ...privateState, mode: 'hidden' } }
    ]) {
      await expect(
        createDAppExecutionModeClient(async () => response).read()
      ).rejects.toBeInstanceOf(DAppExecutionModeClientError)
    }
  })
})
