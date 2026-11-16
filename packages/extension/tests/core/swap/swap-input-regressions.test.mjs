import assert from 'node:assert/strict'
import { test } from 'node:test'
import Big from '../../../src/lib/big.ts'
import { formatTokenQuantity, formatBaseUnitDecimalAmount } from '../../../src/lib/number-format.ts'

import { formatDisplayTokenAmount } from '../../../src/popup/components/portfolio/portfolio-format.ts'
import {
  calculateSwapPriceImpact,
  getSwapAmountValues
} from '../../../src/popup/components/swap/swap-estimate.ts'
import { resolveSelectedSwapMaximum } from '../../../src/popup/services/swap-maximum.ts'
import {
  resolveSwapSelectorBalanceMode,
  resolveWalletSwapSourceAvailableRaw,
  resolveManagedSwapRecipient,
  resolveSwapRecipientChainId
} from '../../../src/popup/services/swap-page-model.ts'
import {
  canReverseSwapPair,
  loadReversedSwapPair
} from '../../../src/popup/services/swap-catalog-loading.ts'

const zec = { assetId: 'nep141:zec.omft.near', rheaChainId: 'zcash', blockchain: 'zec' }
const usdc = {
  assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  rheaChainId: '42161',
  blockchain: 'arb'
}
const zcashChain = {
  id: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  family: 'zcash',
  network: { kind: 'mainnet' }
}
const arbitrumChain = { id: 'eip155:42161', family: 'evm', network: { kind: 'mainnet' } }

test('only the current destination account can restore a managed recipient and allow reversal', () => {
  const publicAddress = `0x${'a'.repeat(40)}`
  const privateAddress = `0x${'b'.repeat(40)}`
  const input = { walletAddress: publicAddress, privateAddress, isEvm: true }
  assert.equal(
    resolveManagedSwapRecipient({ ...input, address: publicAddress.toUpperCase() }),
    'main'
  )
  assert.equal(resolveManagedSwapRecipient({ ...input, address: privateAddress }), 'private')
  assert.equal(resolveManagedSwapRecipient({ ...input, address: `0x${'c'.repeat(40)}` }), null)
  assert.equal(resolveManagedSwapRecipient({ ...input, address: '' }), null)
  const zcash = { zcashAddresses: { shielded: 'u1own', transparent: 't1own' }, isEvm: false }
  assert.equal(resolveManagedSwapRecipient({ ...zcash, address: 't1own' }), 'transparent')
  assert.equal(resolveManagedSwapRecipient({ ...zcash, address: 'u1own' }), 'shielded')
  assert.equal(resolveManagedSwapRecipient({ ...zcash, address: 'U1OWN' }), null)
  assert.equal(
    resolveManagedSwapRecipient({
      address: 'Alice.near',
      walletAddress: 'alice.near',
      isEvm: false
    }),
    null
  )
})

test('recipient books follow the destination chain even without a current account receive target', () => {
  assert.equal(resolveSwapRecipientChainId(usdc, 'mainnet'), arbitrumChain.id)
  assert.equal(resolveSwapRecipientChainId(zec, 'mainnet'), zcashChain.id)
  assert.equal(resolveSwapRecipientChainId(null, 'mainnet'), null)
  assert.equal(resolveSwapRecipientChainId({ rheaChainId: 'unsupported' }, 'mainnet'), null)
})

test('large quote output stays decimal through fiat, exchange rate and price impact calculations', () => {
  const amountOut = formatBaseUnitDecimalAmount('4483300000', 6)
  assert.equal(amountOut, '4483.3')
  const input = { amountIn: '3.83', amountOut, tokenInPrice: 1200, tokenOutPrice: 1 }
  const values = getSwapAmountValues(input)
  assert.equal(values.toFiat, '4483.3')
  assert.equal(values.fromFiat, '4596')
  assert.equal(values.rate, new Big('4483.3').div('3.83').toFixed())
  assert.ok(Math.abs(calculateSwapPriceImpact(input) - 2.4521322889469103) < 1e-10)
  assert.equal(formatTokenQuantity(amountOut), '4,483.3')
})

test('whole amounts never use K/M/B or lose integer precision during rendering', () => {
  assert.equal(formatDisplayTokenAmount('1234567000000', 6), '1,234,567')
  assert.equal(formatDisplayTokenAmount('5000000000000000000000000000', 18), '5,000,000,000')
  assert.equal(
    formatTokenQuantity('123456789012345678901234567890'),
    '123,456,789,012,345,678,901,234,567,890'
  )
  assert.equal(formatTokenQuantity('-12345.12345'), '-12,345.12')
})

test('Max follows a lower settled fee estimate while a manually entered amount is preserved', () => {
  const input = { selected: true, currentAmount: '3.83', maximumAmount: '3.82985' }
  assert.equal(resolveSelectedSwapMaximum(input), '3.82985')
  assert.equal(resolveSelectedSwapMaximum({ ...input, selected: false }), null)
  assert.equal(resolveSelectedSwapMaximum({ ...input, currentAmount: '3.82985' }), null)
  assert.equal(resolveSelectedSwapMaximum({ ...input, maximumAmount: '0' }), '0')
})

test('asset selector balances follow their own side and never claim an unknown private balance is zero', () => {
  const input = {
    sourceMode: 'main',
    destinationMode: 'private',
    isPrivateFunding: false,
    externalRecipient: false
  }
  assert.equal(resolveSwapSelectorBalanceMode({ ...input, purpose: 'in' }), 'main')
  assert.equal(resolveSwapSelectorBalanceMode({ ...input, purpose: 'out' }), 'private')
  assert.equal(
    resolveSwapSelectorBalanceMode({ ...input, purpose: 'out', externalRecipient: true }),
    null
  )
  const asset = {
    family: 'evm',
    asset: { balance: { availableRaw: '99', mainRaw: '90', privateRaw: '9' } }
  }
  assert.equal(resolveWalletSwapSourceAvailableRaw(asset, 'main'), '90')
  assert.equal(resolveWalletSwapSourceAvailableRaw(asset, 'private'), '9')
  assert.equal(
    resolveWalletSwapSourceAvailableRaw(
      { ...asset, asset: { balance: { availableRaw: '90' } } },
      'private'
    ),
    undefined
  )
})

test('reversal loads the supported destination as a source before changing the pair', async () => {
  assert.equal(canReverseSwapPair(usdc, zec, [zcashChain, arbitrumChain]), true)
  assert.equal(canReverseSwapPair(usdc, zec, [arbitrumChain]), false)
  const sourceZec = { ...zec, direction: 'source' }
  const destinationUsdc = { ...usdc, direction: 'destination' }
  const input = {
    tokenIn: usdc,
    tokenOut: zec,
    isCancelled: () => false,
    loadSources: async () => [sourceZec],
    loadDestinations: async () => [destinationUsdc]
  }
  assert.deepEqual(await loadReversedSwapPair(input), {
    tokenIn: sourceZec,
    tokenOut: destinationUsdc
  })
  assert.equal(await loadReversedSwapPair({ ...input, isCancelled: () => true }), null)
  await assert.rejects(
    loadReversedSwapPair({ ...input, loadSources: async () => [] }),
    /reverse direction/
  )
})
