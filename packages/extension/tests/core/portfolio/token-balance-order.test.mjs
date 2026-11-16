import { test } from 'node:test'
import { expect } from '@playwright/test'

import { sortTokensByBalanceValue } from '../../../src/popup/components/tokens/token-balance-order.ts'

function token(assetId, symbol, price, blockchain = 'eth') {
  return { assetId, symbol, price, blockchain, decimals: 18, priceUpdatedAt: '' }
}

test('sorts held tokens by fiat value before unpriced, zero, and unowned assets', () => {
  const tokens = [
    token('missing', 'MISSING', 100),
    token('zero', 'ZERO', 100),
    token('unpriced', 'UNPRICED', 0),
    token('second', 'SECOND', 10),
    token('first', 'FIRST', 2)
  ]
  const balances = new Map([
    ['zero', '0'],
    ['unpriced', '500'],
    ['second', '10'],
    ['first', '100']
  ])

  expect(sortTokensByBalanceValue(tokens, balances).map(item => item.assetId)).toEqual([
    'first',
    'second',
    'unpriced',
    'zero',
    'missing'
  ])
})

test('does not mutate provider order when balances are unavailable', () => {
  const tokens = [token('b', 'B', 1), token('a', 'A', 1)]
  expect(sortTokensByBalanceValue(tokens)).toBe(tokens)
})
