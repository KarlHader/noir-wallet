import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  publishHardwareSignResult,
  waitForHardwareSignResult
} from '../../../src/lib/hardware-sign-result.ts'

function createChromeMock() {
  const values = new Map()
  const storageListeners = new Set()
  const removedListeners = new Set()
  const removedTabs = []
  return {
    values,
    removedTabs,
    chrome: {
      storage: {
        session: {
          get: async key => ({ [key]: values.get(key) }),
          set: async items => {
            for (const [key, value] of Object.entries(items)) values.set(key, value)
          },
          remove: async key => values.delete(key)
        },
        onChanged: {
          addListener: listener => storageListeners.add(listener),
          removeListener: listener => storageListeners.delete(listener)
        }
      },
      tabs: {
        onRemoved: {
          addListener: listener => removedListeners.add(listener),
          removeListener: listener => removedListeners.delete(listener)
        },
        remove: async tabId => removedTabs.push(tabId)
      },
      emitStorage: (changes, areaName = 'session') => {
        for (const listener of storageListeners) listener(changes, areaName)
      },
      emitTabRemoved: tabId => {
        for (const listener of removedListeners) listener(tabId)
      }
    }
  }
}

test.describe('side-panel hardware signing result', () => {
  let originalChrome

  test.beforeEach(() => {
    originalChrome = globalThis.chrome
  })

  test.afterEach(() => {
    if (originalChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = originalChrome
  })

  test('reads a request-bound result persisted before the waiter starts', async () => {
    const mock = createChromeMock()
    globalThis.chrome = mock.chrome
    const result = {
      requestId: 'request-1',
      status: 'success',
      txHash: 'a'.repeat(64),
      accountKey: 'mainnet:wallet-1:account-1',
      amount: '1.25',
      transactionId: 'transaction-1',
      completedAt: Date.now()
    }

    await publishHardwareSignResult(result)
    await expect(waitForHardwareSignResult({ requestId: 'request-1', tabId: 7 })).resolves.toEqual(
      result
    )
    expect(mock.values.has('hw_sign_result_request-1')).toBe(false)
  })

  test('ignores malformed results and resolves cancellation when the signing tab closes', async () => {
    const mock = createChromeMock()
    globalThis.chrome = mock.chrome
    const waiting = waitForHardwareSignResult({ requestId: 'request-2', tabId: 8 })
    mock.chrome.emitStorage(
      {
        'hw_sign_result_request-2': {
          newValue: {
            requestId: 'request-2',
            status: 'success',
            txHash: 'a'.repeat(64),
            accountKey: 'account',
            amount: '1',
            completedAt: Date.now(),
            unvalidated: true
          }
        }
      },
      'session'
    )
    mock.chrome.emitTabRemoved(8)

    await expect(waiting).resolves.toMatchObject({ requestId: 'request-2', status: 'cancelled' })
  })

  test('times out and closes the standalone signing tab', async () => {
    const mock = createChromeMock()
    globalThis.chrome = mock.chrome

    await expect(
      waitForHardwareSignResult({ requestId: 'request-3', tabId: 9, timeoutMs: 5 })
    ).resolves.toMatchObject({ requestId: 'request-3', status: 'timeout' })
    expect(mock.removedTabs).toEqual([9])
  })
})
