import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeeQuoteRegistry } from '../../../../src/core/zcash/fee-quotes.ts'

const context = {
  walletId: 'wallet',
  accountId: 2,
  network: 'mainnet',
  rpcUrl: 'https://rpc.example'
}

test('binds a quoted fee to wallet, account, network, RPC and expiry', async () => {
  let now = 100
  const registry = new FeeQuoteRegistry(
    () => now,
    () => 'quote-1'
  )
  const quote = await registry.get(context, async () => 7_000)
  assert.equal(quote.standardMarginalFeeZats, 7_000)
  assert.equal(registry.validate(context, quote.id, 28_000).id, quote.id)
  assert.throws(() => registry.validate({ ...context, accountId: 3 }, quote.id, 7_000))
  assert.throws(() =>
    registry.validate({ ...context, rpcUrl: 'https://other.example' }, quote.id, 7_000)
  )
  assert.throws(() => registry.validate(context, quote.id, 20_000))
  now = quote.expiresAt
  assert.throws(() => registry.validate(context, quote.id, 7_000))
})

test('invalidates an existing quote when the wallet runtime changes', async () => {
  const registry = new FeeQuoteRegistry(
    () => 100,
    () => 'quote-2'
  )
  const quote = await registry.get(context, async () => 5_000)
  registry.invalidateWallet(context.walletId)
  assert.throws(() => registry.validate(context, quote.id, 5_000))
})

test('keeps the fixed fee reviewable when the RPC recommendation fails or is invalid', async () => {
  const recommendations = [
    async () => {
      throw new Error('GetStandardFee unavailable')
    },
    async () => 0,
    async () => Number.MAX_SAFE_INTEGER
  ]

  for (const recommend of recommendations) {
    const registry = new FeeQuoteRegistry(
      () => 100,
      () => 'fallback-quote'
    )
    const quote = await registry.get(context, recommend)
    assert.equal(quote.standardMarginalFeeZats, 5_000)
    assert.equal(registry.validate(context, quote.id, 5_000).id, quote.id)
    assert.equal(registry.validate(context, quote.id, 20_000).id, quote.id)
    assert.throws(() => registry.validate(context, quote.id, 7_000))
  }
})
