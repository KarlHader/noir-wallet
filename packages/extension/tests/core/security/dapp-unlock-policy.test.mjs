import { test } from 'node:test'
import { expect } from '@playwright/test'

import { isExplicitMultichainConnectRequest } from '../../../src/background/dapp-unlock-policy.ts'

function request(chainId, method) {
  return { type: 'DAPP_REQUEST', requestId: 'request-1', chainId, request: { method } }
}

test.describe('dApp unlock policy', () => {
  test('prompts only for explicit multichain connection requests', () => {
    for (const [chainId, method] of [
      ['evm', 'eth_requestAccounts'],
      ['evm', 'wallet_requestPermissions'],
      ['bitcoin', 'connect'],
      ['bitcoin', 'requestAccounts'],
      ['solana', 'connect'],
      ['solana', 'requestAccounts'],
      ['near', 'connect'],
      ['near', 'requestAccounts']
    ]) {
      expect(isExplicitMultichainConnectRequest(request(chainId, method))).toBe(true)
    }

    for (const [chainId, method] of [
      ['evm', 'eth_accounts'],
      ['bitcoin', 'getAccounts'],
      ['solana', 'getAccounts'],
      ['near', 'getAccounts'],
      ['zcash', 'zcash_requestAccounts']
    ]) {
      expect(isExplicitMultichainConnectRequest(request(chainId, method))).toBe(false)
    }
  })
})
