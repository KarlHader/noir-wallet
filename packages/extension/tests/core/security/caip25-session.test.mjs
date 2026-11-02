import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  caip25SessionAllowsMethod,
  parseCaip25CreateSessionRequest,
  parseCaip27InvokeMethodRequest
} from '../../../src/core/dapp/caip25.ts'
import {
  parseStoredDAppConnection,
  pruneDAppAccountReferences,
  replaceDAppCaip25Session
} from '../../../src/core/dapp/dapp-manager.ts'

const ethereum = 'eip155:1'
const bitcoin = 'bip122:000000000019d6689c085ae165831e93'

test.describe('CAIP-25 sessions', () => {
  test('parses chain-specific scopes, properties, and CAIP-27 invocation', () => {
    const request = parseCaip25CreateSessionRequest({
      scopes: {
        [ethereum]: {
          chains: [ethereum],
          accounts: [`${ethereum}:0x1111111111111111111111111111111111111111`],
          methods: ['eth_accounts', 'personal_sign'],
          notifications: ['wallet_sessionChanged', 'accountsChanged']
        },
        [bitcoin]: {
          methods: ['getAccounts', 'signMessage'],
          notifications: ['wallet_sessionChanged']
        }
      },
      properties: { application: 'Example' }
    })

    expect(Object.keys(request.scopes)).toEqual([ethereum, bitcoin])
    expect(request.properties).toEqual({ application: 'Example' })
    expect(
      parseCaip27InvokeMethodRequest({
        scope: ethereum,
        request: { method: 'personal_sign', params: ['0x1234'] }
      })
    ).toEqual({
      scope: ethereum,
      request: { method: 'personal_sign', params: ['0x1234'] }
    })
  })

  test('rejects namespace scopes, cross-chain accounts, and duplicate methods', () => {
    expect(() =>
      parseCaip25CreateSessionRequest({
        scopes: {
          eip155: { methods: ['eth_accounts'], notifications: [] }
        }
      })
    ).toThrow()
    expect(() =>
      parseCaip25CreateSessionRequest({
        scopes: {
          [ethereum]: {
            accounts: [`${bitcoin}:bc1qexample`],
            methods: ['eth_accounts'],
            notifications: []
          }
        }
      })
    ).toThrow(/does not belong/)
    expect(() =>
      parseCaip25CreateSessionRequest({
        scopes: {
          [ethereum]: {
            methods: ['eth_accounts', 'eth_accounts'],
            notifications: []
          }
        }
      })
    ).toThrow(/Duplicate/)
  })

  test('commits chain permissions and session metadata as one validated record', () => {
    const account = { walletId: 'wallet-1', accountId: 'account-1' }
    const connection = replaceDAppCaip25Session(undefined, {
      origin: 'https://session.example',
      id: 'session-example',
      authorizations: [
        { chainId: ethereum, accounts: [account], binding: account },
        { chainId: bitcoin, accounts: [account], binding: account }
      ],
      session: {
        scopes: [
          { chainId: ethereum, methods: ['eth_accounts'], notifications: ['accountsChanged'] },
          { chainId: bitcoin, methods: ['getAccounts'], notifications: ['accountsChanged'] }
        ]
      },
      now: 1_700_000_000_000
    })

    expect(parseStoredDAppConnection(connection).caip25Session?.scopes).toHaveLength(2)
    const pruned = pruneDAppAccountReferences([connection], account)
    expect(pruned.connections).toEqual([])
    expect(pruned.disconnectedOrigins).toEqual(['https://session.example'])
  })

  test('rejects a session scope without its account authorization', () => {
    const account = { walletId: 'wallet-1', accountId: 'account-1' }
    expect(() =>
      replaceDAppCaip25Session(undefined, {
        origin: 'https://session.example',
        id: 'session-example',
        authorizations: [{ chainId: ethereum, accounts: [account], binding: account }],
        session: {
          scopes: [{ chainId: bitcoin, methods: ['getAccounts'], notifications: [] }]
        },
        now: 1_700_000_000_000
      })
    ).toThrow(/requires a chain authorization/)
  })

  test('limits legacy chain calls to methods granted by a matching session scope', () => {
    const session = {
      scopes: [{ chainId: ethereum, methods: ['eth_accounts'], notifications: [] }]
    }
    expect(caip25SessionAllowsMethod(session, ethereum, 'eth_accounts')).toBe(true)
    expect(caip25SessionAllowsMethod(session, ethereum, 'eth_sendTransaction')).toBe(false)
    expect(caip25SessionAllowsMethod(session, bitcoin, 'sendBitcoin')).toBe(true)
    expect(caip25SessionAllowsMethod(null, ethereum, 'eth_sendTransaction')).toBe(true)
  })
})
