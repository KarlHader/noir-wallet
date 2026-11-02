import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  consumePreparedHardwareSignRequest,
  isHardwareSignRequestFresh,
  openHardwareSignTab,
  parsePreparedHardwareSignRequest,
  parseHardwareSignRequest,
  readHardwareSignRequest,
  writePreparedHardwareSignRequest
} from '../../../src/lib/hardware-tab.ts'

test.describe('Hardware sign request handoff', () => {
  test('binds Ledger signatures to a redacted PCZT and a transparent funding request', () => {
    const request = parseHardwareSignRequest({
      kind: 'send',
      walletId: 'ledger-wallet',
      accountId: 'ledger-account',
      to: 'u1recipient',
      amount: '1',
      memo: 'Private memo',
      fundingSource: 'transparent',
      maxTransfer: true,
      createdAt: 1_000
    })
    expect(request.fundingSource).toBe('transparent')
    expect(request.maxTransfer).toBe(true)
    expect(request.memo).toBe('Private memo')
    expect(
      parsePreparedHardwareSignRequest({
        request,
        fullPcztBase64: 'YWJjZA==',
        redactedPcztBase64: 'YWJjZA==',
        vendor: 'ledger'
      })
    ).toMatchObject({ vendor: 'ledger', request })
    expect(() =>
      parsePreparedHardwareSignRequest({
        request,
        fullPcztBase64: 'YWJjZA==',
        vendor: 'ledger'
      })
    ).toThrow('Invalid redacted hardware PCZT')
    expect(() =>
      parseHardwareSignRequest({ ...request, kind: 'shield', maxTransfer: undefined })
    ).toThrow('Invalid hardware funding source')
    expect(() => parseHardwareSignRequest({ ...request, maxTransfer: 'true' })).toThrow(
      'Invalid hardware maximum transfer'
    )
  })
  test('consumes one prepared session request and full PCZT exactly once', async () => {
    const originalChrome = globalThis.chrome
    const createdAt = Date.now()
    const request = {
      kind: 'send',
      walletId: 'wallet-1',
      accountId: 'account-1',
      to: 'u1recipient',
      amount: '1',
      createdAt
    }
    const storage = new Map([
      ['hw_sign_request-1', request],
      [
        'hw_sign_prepared_request-1',
        {
          request,
          fullPcztBase64: 'YWJjZA=='
        }
      ]
    ])
    globalThis.chrome = {
      storage: {
        session: {
          get: async keys =>
            Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map(key => [key, storage.get(key)])
            ),
          remove: async key => {
            for (const item of Array.isArray(key) ? key : [key]) storage.delete(item)
          }
        }
      }
    }

    try {
      await expect(consumePreparedHardwareSignRequest('request-1')).resolves.toMatchObject({
        request: { walletId: 'wallet-1', accountId: 'account-1' },
        fullPcztBase64: 'YWJjZA=='
      })
      await expect(consumePreparedHardwareSignRequest('request-1')).resolves.toBeNull()
      await expect(readHardwareSignRequest('request-1')).resolves.toBeNull()
    } finally {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })

  test('does not return a prepared request when session removal fails', async () => {
    const originalChrome = globalThis.chrome
    const createdAt = Date.now()
    const prepared = {
      request: {
        kind: 'send',
        walletId: 'wallet-1',
        accountId: 'account-1',
        to: 'u1recipient',
        amount: '1',
        createdAt
      },
      fullPcztBase64: 'YWJjZA=='
    }
    globalThis.chrome = {
      storage: {
        session: {
          get: async keys =>
            Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map(key => [
                key,
                key.startsWith('hw_sign_prepared_') ? prepared : prepared.request
              ])
            ),
          remove: async () => {
            throw new Error('session write failed')
          }
        }
      }
    }

    try {
      await expect(consumePreparedHardwareSignRequest('request-1')).rejects.toThrow(
        'session write failed'
      )
    } finally {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })

  test('stores the full PCZT only in the prepared Background binding', async () => {
    const originalChrome = globalThis.chrome
    const stored = new Map()
    const createdAt = Date.now()
    globalThis.chrome = {
      storage: {
        session: {
          set: async values => {
            for (const [key, value] of Object.entries(values)) stored.set(key, value)
          }
        }
      }
    }

    try {
      await writePreparedHardwareSignRequest('request-1', {
        request: {
          kind: 'send',
          walletId: 'wallet-1',
          accountId: 'account-1',
          to: 'u1recipient',
          amount: '1',
          createdAt
        },
        fullPcztBase64: 'YWJjZA=='
      })
      expect(stored.get('hw_sign_prepared_request-1')).toMatchObject({
        fullPcztBase64: 'YWJjZA=='
      })
    } finally {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })

  test('removes a request when its signing tab cannot be created', async () => {
    const originalChrome = globalThis.chrome
    const removed = []
    globalThis.chrome = {
      runtime: {
        getURL: path => `chrome-extension://wallet/${path}`
      },
      storage: {
        session: {
          set: async () => {},
          remove: async keys => removed.push(keys)
        }
      },
      tabs: {
        create: async () => {
          throw new Error('tab creation failed')
        }
      }
    }

    try {
      await expect(
        openHardwareSignTab({
          kind: 'send',
          walletId: 'wallet-1',
          accountId: 'account-1',
          to: 'u1recipient',
          amount: '1'
        })
      ).rejects.toThrow('tab creation failed')
      expect(removed).toHaveLength(1)
      expect(removed[0]).toHaveLength(2)
      expect(removed[0][0]).toMatch(/^hw_sign_/)
      expect(removed[0][1]).toMatch(/^hw_sign_prepared_/)
    } finally {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })

  test('rejects malformed, cross-kind, and future session requests', () => {
    const request = {
      kind: 'send',
      walletId: 'wallet-1',
      accountId: 'account-1',
      to: 'u1recipient',
      amount: '1',
      createdAt: 1_000
    }
    expect(parseHardwareSignRequest(request)).toEqual(request)
    expect(() => parseHardwareSignRequest({ ...request, unknown: true })).toThrow(
      'Invalid hardware signing request'
    )
    expect(() => parseHardwareSignRequest({ ...request, kind: 'shield' })).toThrow(
      'Invalid hardware signing request fields'
    )
    expect(() => parseHardwareSignRequest({ ...request, dappRequestId: 'request-1' })).toThrow(
      'Invalid hardware dApp request binding'
    )
    expect(isHardwareSignRequestFresh(request, 1_001)).toBe(true)
    expect(isHardwareSignRequestFresh(request, 999)).toBe(false)
  })

  test('accepts only the supported field combinations for every Zcash flow', () => {
    const base = { walletId: 'wallet-1', accountId: 'account-1', amount: '1', createdAt: 1_000 }
    expect(parseHardwareSignRequest({ ...base, kind: 'shield' })).toMatchObject({ kind: 'shield' })
    expect(
      parseHardwareSignRequest({ ...base, kind: 'unshield', to: 't1transparent' })
    ).toMatchObject({ kind: 'unshield', to: 't1transparent' })
    expect(() => parseHardwareSignRequest({ ...base, kind: 'unshield' })).toThrow(
      'Invalid hardware signing request fields'
    )
    expect(
      parseHardwareSignRequest({
        ...base,
        kind: 'send',
        to: 'u1recipient',
        memo: '',
        dappRequestId: 'dapp-request-1',
        origin: 'https://dapp.example'
      })
    ).toMatchObject({ kind: 'send', memo: '', origin: 'https://dapp.example' })
    expect(
      parseHardwareSignRequest({
        ...base,
        kind: 'swap',
        to: 'u1deposit',
        displayTo: '0xrecipient',
        quoteBinding: {
          depositAddress: 'u1deposit',
          originAsset: 'nep141:zec',
          destinationAsset: 'nep141:eth',
          minAmountOut: '0.1',
          deadline: 2_000
        },
        monitorParams: {
          depositAddress: 'u1deposit',
          tokenInSymbol: 'ZEC',
          tokenOutSymbol: 'ETH',
          amountOut: '0.1',
          actionName: 'Swap'
        }
      })
    ).toMatchObject({ kind: 'swap', displayTo: '0xrecipient' })
  })

  test('deletes corrupted prepared session state instead of returning it', async () => {
    const originalChrome = globalThis.chrome
    const removed = []
    globalThis.chrome = {
      storage: {
        session: {
          get: async keys => {
            const createdAt = Date.now()
            const request = {
              kind: 'send',
              walletId: 'wallet-1',
              accountId: 'account-1',
              to: 'u1recipient',
              amount: '1',
              createdAt
            }
            return Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map(key => [
                key,
                key.startsWith('hw_sign_prepared_')
                  ? {
                      request: { ...request, substituted: true },
                      fullPcztBase64: 'YWJjZA=='
                    }
                  : request
              ])
            )
          },
          remove: async keys => removed.push(keys)
        }
      }
    }

    try {
      await expect(consumePreparedHardwareSignRequest('request-1')).resolves.toBeNull()
      expect(removed).toHaveLength(1)
      expect(removed[0]).toEqual(['hw_sign_request-1', 'hw_sign_prepared_request-1'])
    } finally {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })

  test('deletes a valid prepared record when it no longer matches the original request', async () => {
    const originalChrome = globalThis.chrome
    const removed = []
    const originalRequest = {
      kind: 'send',
      walletId: 'wallet-1',
      accountId: 'account-1',
      to: 'u1original',
      amount: '1',
      createdAt: Date.now()
    }
    globalThis.chrome = {
      storage: {
        session: {
          get: async keys =>
            Object.fromEntries(
              keys.map(key => [
                key,
                key.startsWith('hw_sign_prepared_')
                  ? {
                      request: { ...originalRequest, to: 'u1substituted' },
                      fullPcztBase64: 'YWJjZA=='
                    }
                  : originalRequest
              ])
            ),
          remove: async keys => removed.push(keys)
        }
      }
    }

    try {
      await expect(consumePreparedHardwareSignRequest('request-1')).resolves.toBeNull()
      expect(removed).toEqual([['hw_sign_request-1', 'hw_sign_prepared_request-1']])
    } finally {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })

  test('deletes a future original request instead of returning it', async () => {
    const originalChrome = globalThis.chrome
    const removed = []
    globalThis.chrome = {
      storage: {
        session: {
          get: async key => ({
            [key]: {
              kind: 'send',
              walletId: 'wallet-1',
              accountId: 'account-1',
              to: 'u1recipient',
              amount: '1',
              createdAt: Date.now() + 60_000
            }
          }),
          remove: async keys => removed.push(keys)
        }
      }
    }

    try {
      await expect(readHardwareSignRequest('request-1')).resolves.toBeNull()
      expect(removed).toEqual([['hw_sign_request-1', 'hw_sign_prepared_request-1']])
    } finally {
      if (originalChrome === undefined) delete globalThis.chrome
      else globalThis.chrome = originalChrome
    }
  })

  test('allows origin result reporting only for extension initiated signing requests', () => {
    const base = {
      kind: 'send',
      walletId: 'wallet-1',
      accountId: 'account-1',
      to: 'u1recipient',
      amount: '1',
      createdAt: 1_000
    }
    expect(parseHardwareSignRequest({ ...base, reportToOrigin: true })).toMatchObject({
      reportToOrigin: true
    })
    expect(() => parseHardwareSignRequest({ ...base, reportToOrigin: 'true' })).toThrow(
      'Invalid hardware dApp request binding'
    )
    expect(() =>
      parseHardwareSignRequest({
        ...base,
        reportToOrigin: true,
        dappRequestId: 'dapp-request-1',
        origin: 'https://dapp.example'
      })
    ).toThrow('Invalid hardware dApp request binding')
  })
})
