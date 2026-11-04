import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectSwapFeeEstimate } from '../src/lib/swap-fee.ts'
import { FeeQuoteRegistry } from '../src/core/zcash/fee-quotes.ts'
import { fetchStandardMarginalFee } from '../src/config/rpc-registry-client.ts'
import { marginalFeeForTier, FEE_QUOTE_TTL_MS } from '../src/config/fee.ts'

const context = {
  walletId: 'wallet',
  accountId: 7,
  network: 'testnet',
  rpcUrl: 'https://rpc.example'
}

test('concurrent estimates share a recommendation and keep its approved rate for submission', async () => {
  let calls = 0
  let now = 100
  const registry = new FeeQuoteRegistry(
    () => now,
    () => 'quote'
  )
  const recommend = async () => {
    calls++
    return 1_000
  }
  const [estimate, max] = await Promise.all([
    registry.get(context, recommend),
    registry.get(context, recommend)
  ])
  assert.deepEqual(estimate, max)
  assert.equal(calls, 1)
  assert.equal(marginalFeeForTier('fast', estimate.standardMarginalFeeZats), 4_000)
  now += FEE_QUOTE_TTL_MS - 1
  assert.equal(registry.validate(context, estimate.id, 1_000).id, estimate.id)
  assert.equal(registry.validate(context, max.id, 4_000).id, max.id)
  assert.equal((await registry.get(context, async () => 50_001)).standardMarginalFeeZats, 1_000)
})

test('quotes reject forged fees, forged identifiers, changed contexts and expiry', async () => {
  let now = 100
  const registry = new FeeQuoteRegistry(
    () => now,
    () => 'quote'
  )
  const quote = await registry.get(context, async () => 50_001)
  for (const rate of [0, -1, 5000, 50_002, 200_005, NaN, Infinity, '50001', undefined]) {
    assert.throws(() => registry.validate(context, quote.id, rate), /approved quote/)
  }
  for (const other of [
    { ...context, walletId: 'other' },
    { ...context, accountId: 8 },
    { ...context, network: 'mainnet' },
    { ...context, rpcUrl: 'https://other.example' }
  ])
    assert.throws(() => registry.validate(other, quote.id, 50_001), /expired or changed/)
  for (const id of [undefined, 'forged']) {
    assert.throws(() => registry.validate(context, id, 50_001), /expired or changed/)
  }
  now += FEE_QUOTE_TTL_MS
  assert.throws(() => registry.validate(context, quote.id, 50_001), /expired or changed/)
})

test('unsupported and invalid recommendations fall back without trusting caller-owned objects', async () => {
  for (const rate of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER, '1000']) {
    const registry = new FeeQuoteRegistry(
      () => 1,
      () => 'fallback'
    )
    const quote = await registry.get(context, async () => rate)
    assert.equal(quote.standardMarginalFeeZats, 5_000)
    quote.standardMarginalFeeZats = 1
    assert.throws(() => registry.validate(context, quote.id, 1), /approved quote/)
    assert.equal(registry.validate(context, quote.id, 20_000).standardMarginalFeeZats, 5_000)
  }
  const registry = new FeeQuoteRegistry()
  assert.equal(
    (
      await registry.get(context, async () => {
        throw new Error('UNIMPLEMENTED')
      })
    ).standardMarginalFeeZats,
    5_000
  )
})

test('runtime replacement invalidates both existing quotes and an in-flight recommendation', async () => {
  let sequence = 0
  const registry = new FeeQuoteRegistry(Date.now, () => `quote-${sequence++}`)
  const quote = await registry.get(context, async () => 1_000)
  registry.invalidateWallet(context.walletId)
  assert.throws(() => registry.validate(context, quote.id, 1_000), /expired or changed/)
  let finish
  const pending = registry.get(
    context,
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  registry.invalidateWallet(context.walletId)
  const fresh = registry.get(context, async () => 2_000)
  assert.equal((await fresh).standardMarginalFeeZats, 2_000)
  finish(50_001)
  await assert.rejects(pending, /Wallet changed/)
  assert.equal((await registry.get(context, async () => 3_000)).standardMarginalFeeZats, 2_000)
})

function varint(value) {
  const bytes = []
  let remaining = BigInt(value)
  do {
    const byte = Number(remaining & 127n)
    remaining >>= 7n
    bytes.push(byte | (remaining ? 128 : 0))
  } while (remaining)
  return bytes
}

function response(message, status = '0') {
  const trailers = new TextEncoder().encode(`grpc-status: ${status}\r\n`)
  const bytes = new Uint8Array(10 + message.length + trailers.length)
  new DataView(bytes.buffer).setUint32(1, message.length)
  bytes.set(message, 5)
  bytes[5 + message.length] = 0x80
  new DataView(bytes.buffer).setUint32(6 + message.length, trailers.length)
  bytes.set(trailers, 10 + message.length)
  return new Response(bytes, { headers: { 'content-type': 'application/grpc-web+proto' } })
}

test('GetStandardFee decodes uint64 fees and preserves the existing bounded gRPC transport', async () => {
  for (const rate of [1_000, 50_001, 4_294_967_296]) {
    const fee = await fetchStandardMarginalFee(context.rpcUrl, async (url, init) => {
      assert.equal(url, `${context.rpcUrl}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetStandardFee`)
      assert.equal(init.credentials, 'omit')
      assert.deepEqual(init.body, new Uint8Array(5))
      return response(Uint8Array.from([8, ...varint(rate), 16, 2]))
    })
    assert.equal(fee, rate)
  }
  for (const bytes of [
    [],
    [8, 0],
    [8, 1, 8, 2],
    [10, 1, 1],
    [8, 128],
    [8, ...varint(2n ** 64n - 1n)],
    [8, ...Array(10).fill(255), 1],
    [...varint((2n ** 29n + 1n) * 8n), ...varint(1_000)]
  ])
    await assert.rejects(
      fetchStandardMarginalFee(context.rpcUrl, async () => response(Uint8Array.from(bytes)))
    )
  await assert.rejects(
    fetchStandardMarginalFee(context.rpcUrl, async () => response(Uint8Array.of(8, 1), '12')),
    /gRPC status 12/
  )
})

test('recommendation timeout aborts the request and releases its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let aborted = false
  const result = fetchStandardMarginalFee(
    context.rpcUrl,
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error('aborted'))
          },
          { once: true }
        )
      })
  )
  const rejected = assert.rejects(result, /aborted/)
  t.mock.timers.tick(5_000)
  await rejected
  assert.equal(aborted, true)
})

test('swap confirmation requires a fee quote for the actual amount after Max changes', () => {
  const maxQuote = {
    id: 'max-quote',
    standardMarginalFeeZats: 50_000,
    expiresAt: Date.now() + 60_000
  }
  const amountQuote = { ...maxQuote, id: 'amount-quote' }
  const max = { feeZats: 150_000, feeQuote: maxQuote, loading: false, error: false }
  const amount = { ...max, feeZats: 200_000, feeQuote: amountQuote }

  const reviewed = selectSwapFeeEstimate('0.9985', true, '0.9985', max, amount)
  assert.equal(reviewed.ready, true)
  assert.equal(reviewed.feeZats, 150_000)
  assert.equal(reviewed.feeQuote.id, maxQuote.id)

  // A balance increase leaves the approved amount affordable, but it is no longer Max.
  const stale = selectSwapFeeEstimate('0.9985', true, '1.9985', max, amount)
  assert.equal(stale.staleMax, true)
  assert.equal(stale.ready, false)
  assert.equal(stale.feeZats, null)
  assert.equal(stale.feeQuote, null)

  const reestimated = selectSwapFeeEstimate('0.9985', false, '1.9985', max, amount)
  assert.equal(reestimated.ready, true)
  assert.equal(reestimated.feeZats, 200_000)
  assert.equal(reestimated.feeQuote.id, amountQuote.id)

  for (const unavailable of [
    { ...amount, feeZats: null },
    { ...amount, feeQuote: null },
    { ...amount, loading: true },
    { ...amount, error: true }
  ]) {
    assert.equal(selectSwapFeeEstimate('0.9985', false, '1.9985', max, unavailable).ready, false)
  }
  assert.equal(selectSwapFeeEstimate('0.9985', true, null, max, amount).ready, false)
})
