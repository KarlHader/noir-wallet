import { test } from 'node:test'
import { expect } from '@playwright/test'

import { AccountContextTransitionCoordinator } from '../../../src/background/account-context-transition.ts'

const account0 = Object.freeze({ walletId: 'wallet:0', accountId: 'account:0' })
const account1 = Object.freeze({ walletId: 'wallet:0', accountId: 'account:1' })

test('serializes active operations with Account invalidation and pointer commit', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  const events = []
  let current = account0
  let releaseOperation
  let markOperationStarted
  const operationBlocked = new Promise(resolve => {
    releaseOperation = resolve
  })
  const operationStarted = new Promise(resolve => {
    markOperationStarted = resolve
  })
  coordinator.registerInvalidator({
    invalidate: async request => {
      events.push(['invalidate', request])
    }
  })

  const active = coordinator.runActiveOperation(async () => {
    events.push(['operation-start', current])
    markOperationStarted()
    await operationBlocked
    events.push(['operation-end', current])
  })
  const switched = coordinator.runAccountSwitch(account1, {
    readCurrent: () => current,
    validateTarget: () => events.push(['validate', account1]),
    commit: async () => {
      events.push(['commit', current, account1])
      current = account1
      return 'switched'
    }
  })
  const afterSwitch = coordinator.runActiveOperation(async () => {
    events.push(['after-switch', current])
  })

  await operationStarted
  expect(events).toEqual([['operation-start', account0]])
  releaseOperation()
  await expect(Promise.all([active, switched, afterSwitch])).resolves.toEqual([
    undefined,
    'switched',
    undefined
  ])
  expect(events).toEqual([
    ['operation-start', account0],
    ['operation-end', account0],
    ['validate', account1],
    ['invalidate', { mode: 'scope', scope: account0 }],
    ['commit', account0, account1],
    ['after-switch', account1]
  ])
})

test('does not change the active pointer when context invalidation fails', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  let current = account0
  let committed = false
  coordinator.registerInvalidator({
    invalidate: async () => {
      throw new Error('signing cancellation unavailable')
    }
  })

  await expect(
    coordinator.runAccountSwitch(account1, {
      readCurrent: () => current,
      validateTarget: () => {},
      commit: async () => {
        committed = true
        current = account1
      }
    })
  ).rejects.toThrow(/cancellation unavailable/)
  expect(committed).toBe(false)
  expect(current).toBe(account0)
})

test('skips invalidation when selecting the already active Account', async () => {
  const coordinator = new AccountContextTransitionCoordinator()
  let invalidations = 0
  coordinator.registerInvalidator({
    invalidate: async () => {
      invalidations += 1
    }
  })

  await coordinator.runAccountSwitch(account0, {
    readCurrent: () => account0,
    validateTarget: () => {},
    commit: async () => {}
  })
  expect(invalidations).toBe(0)
})
