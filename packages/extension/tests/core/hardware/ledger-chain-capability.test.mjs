import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  keySourceSupportsAddressFamily,
  keySourceSupportsChainFamily
} from '../../../src/core/accounts/application/key-source-chain-policy.ts'

test('Ledger Zcash credentials can use Zcash accounts without claiming other chains', () => {
  const source = {
    kind: 'hardware',
    vendor: 'ledger',
    firmwareProfile: 'zcash',
    capabilities: ['zcash']
  }
  expect(keySourceSupportsChainFamily(source, 'zcash')).toBe(true)
  expect(keySourceSupportsAddressFamily(source, 'zcash')).toBe(true)
  for (const family of ['evm', 'bitcoin', 'solana', 'tron', 'near']) {
    expect(keySourceSupportsChainFamily(source, family)).toBe(false)
    expect(keySourceSupportsAddressFamily(source, family)).toBe(false)
  }
})
