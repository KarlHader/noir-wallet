import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '@noble/hashes/sha2'
import { readFile } from 'node:fs/promises'
import { loadWalletWasm } from './helpers/vault-wasm'
import { hexToBytes } from '../../../src/lib/bytes'
import {
  assertPcztConsensusPolicy,
  reviewPreparedPczt
} from '../../../src/core/multisig/pczt-review'
import type * as WalletWasm from '../../../src/lib/wasm-pkg/zcash_wallet_wasm'

const pczt = Uint8Array.of(1, 2, 3)
const recipientRaw = new Uint8Array(43).fill(5)
const emptyMemo = Uint8Array.of(0xf6, ...new Uint8Array(511))
const header = {
  txVersion: 6,
  versionGroupId: 0xd884b698,
  consensusBranchId: 0x37a5165b,
  expiryHeight: 4_134_041,
  coinType: 1
}
const review = [
  sha256(pczt),
  [
    [recipientRaw, 100000, false, emptyMemo],
    [new Uint8Array(43).fill(9), 890000, true, emptyMemo]
  ],
  [[0, new Uint8Array(32).fill(7), 1000000]],
  100000,
  890000,
  10000,
  header
]
const wasm = {
  PcztTools: {
    check() {},
    review: () => review,
    signingSet: () => Uint8Array.of(0),
    action_alphas: () => new Uint8Array(64),
    check_action_bindings() {}
  }
} as unknown as Pick<typeof WalletWasm, 'PcztTools'>
const request = {
  pczt,
  fvk: new Uint8Array(96),
  groupVerifyingKey: new Uint8Array(32),
  network: 'testnet' as const,
  chainTipHeight: 4_134_000,
  recipient: 'u-test-recipient',
  expectedRecipientRaw: recipientRaw,
  amountZats: '100000',
  memo: '',
  maxFeeZats: '15000'
}

test('reviews the actual payment, change, fee and header against the intended transfer', () => {
  const result = reviewPreparedPczt(wasm, request)
  assert.deepEqual(result.summary, {
    recipient: request.recipient,
    amount: request.amountZats,
    memo: request.memo,
    fee: '10000'
  })
  assert.deepEqual([...result.signingIndices], [0])
})

test('refuses changed recipient, amount, memo, network, expiry or review digest', () => {
  for (const patch of [
    { expectedRecipientRaw: new Uint8Array(43).fill(6) },
    { amountZats: '100001' },
    { memo: 'hidden' },
    { network: 'mainnet' as const },
    { chainTipHeight: 4_465_026 },
    { chainTipHeight: 4_134_041 },
    { maxFeeZats: '9999' }
  ])
    assert.throws(() => reviewPreparedPczt(wasm, { ...request, ...patch }))
  const digest = review[0]
  review[0] = new Uint8Array(32)
  try {
    assert.throws(() => reviewPreparedPczt(wasm, request))
  } finally {
    review[0] = digest
  }
})

test('refuses noncanonical signing indexes and unreviewed additional payments', () => {
  const originalSet = wasm.PcztTools.signingSet
  const originalOutputs = review[1]
  try {
    for (const set of [Uint8Array.of(1), Uint8Array.of(0, 0), Uint8Array.of(1, 0)]) {
      wasm.PcztTools.signingSet = () => set
      assert.throws(() => reviewPreparedPczt(wasm, request))
    }
    wasm.PcztTools.signingSet = originalSet
    review[1] = [...(originalOutputs as unknown[]), [recipientRaw, 1, false, emptyMemo]]
    assert.throws(() => reviewPreparedPczt(wasm, request))
  } finally {
    wasm.PcztTools.signingSet = originalSet
    review[1] = originalOutputs
  }
})

test('refuses a review tuple whose spend total does not fund the displayed payment and fee', () => {
  const originalSpends = review[2]
  review[2] = [[0, new Uint8Array(32).fill(7), 999999]]
  try {
    assert.throws(() => reviewPreparedPczt(wasm, request))
  } finally {
    review[2] = originalSpends
  }
})

test('refuses signing sets beyond the u8 action index range before calling WASM signingSet', () => {
  const originalAlphas = wasm.PcztTools.action_alphas
  const originalSet = wasm.PcztTools.signingSet
  let signingSetCalled = false
  wasm.PcztTools.action_alphas = () => new Uint8Array(257 * 32)
  wasm.PcztTools.signingSet = () => {
    signingSetCalled = true
    return Uint8Array.of(0)
  }
  try {
    assert.throws(() => reviewPreparedPczt(wasm, request))
    assert.equal(signingSetCalled, false)
  } finally {
    wasm.PcztTools.action_alphas = originalAlphas
    wasm.PcztTools.signingSet = originalSet
  }
})

test('real WASM reviews a synthetic third-party payment plus change with filler at action zero', async () => {
  const realWasm = await loadWalletWasm()
  const paymentPczt = new Uint8Array(
    await readFile(new URL('./fixtures/ironwood_payment_change.pczt', import.meta.url))
  )
  const viewingKey = hexToBytes(
    '1111111111111111111111111111111111111111111111111111111111111111' +
      'f226a3f879ebe21abfafccb6c521ca749e63ac17fd2cd17870aa72de12d8330d' +
      '047c00ab5e0feca61a461858bb0b15d55f29763a0a282825acebd58698937d24'
  )
  const recipient = hexToBytes(
    'cee87779926d17b1d3de99a6386bb76677b45939ede36b5e253314c1da24b9642d8474b8de3764accdb63b'
  )
  const result = reviewPreparedPczt(realWasm, {
    pczt: paymentPczt,
    fvk: viewingKey,
    groupVerifyingKey: viewingKey.subarray(0, 32),
    network: 'testnet',
    chainTipHeight: 4_134_000,
    recipient: 'synthetic-fixture-recipient',
    expectedRecipientRaw: recipient,
    amountZats: '100000',
    memo: '',
    maxFeeZats: '15000'
  })
  assert.deepEqual([...result.signingIndices], [1])
  assert.equal(result.summary.fee, '10000')
  assert.equal(result.expiryHeight, 4_134_041)
  assert.throws(() =>
    reviewPreparedPczt(realWasm, {
      pczt: paymentPczt,
      fvk: viewingKey,
      groupVerifyingKey: viewingKey.subarray(0, 32),
      network: 'testnet',
      chainTipHeight: 4_134_000,
      recipient: 'synthetic-fixture-recipient',
      expectedRecipientRaw: new Uint8Array(43),
      amountZats: '100000',
      memo: '',
      maxFeeZats: '15000'
    })
  )
})

test('consensus policy selects branch from independent chain tip at upgrade boundaries', () => {
  assert.doesNotThrow(() => assertPcztConsensusPolicy('mainnet', 3_428_143, 0x37a5165b, 3_428_184))
  assert.doesNotThrow(() => assertPcztConsensusPolicy('mainnet', 3_543_405, 0x77190ad9, 3_543_526))
  assert.doesNotThrow(() => assertPcztConsensusPolicy('testnet', 4_134_000, 0x37a5165b, 4_134_041))
  assert.doesNotThrow(() => assertPcztConsensusPolicy('testnet', 4_465_026, 0x77190ad9, 4_465_147))
  for (const [network, tip, branch, expiry] of [
    ['mainnet', 3_428_142, 0x37a5165b, 3_428_183],
    ['testnet', 4_133_999, 0x37a5165b, 4_134_040],
    ['mainnet', 3_543_405, 0x37a5165b, 3_543_446],
    ['testnet', 4_465_026, 0x37a5165b, 4_465_067],
    ['mainnet', 3_543_405, 0x37a5165b, 3_543_526]
  ] as const)
    assert.throws(() => assertPcztConsensusPolicy(network, tip, branch, expiry))
})

test('consensus policy rejects an ordinary expiry across an upgrade or beyond default delta', () => {
  assert.doesNotThrow(() => assertPcztConsensusPolicy('mainnet', 3_543_363, 0x37a5165b, 3_543_404))
  for (const [tip, expiry] of [
    [3_543_364, 3_543_405],
    [3_543_364, 3_543_365],
    [3_543_363, 3_543_405],
    [3_543_363, 3_543_406],
    [3_543_405, 3_543_527],
    [3_543_405, 3_543_405],
    [3_543_405, 0]
  ])
    assert.throws(() =>
      assertPcztConsensusPolicy('mainnet', tip, tip >= 3_543_405 ? 0x77190ad9 : 0x37a5165b, expiry)
    )
})

test('consensus policy rejects even exact ZIP 318 rolling expiry without canonical proof', () => {
  // An expiry matching ZIP 318 does not prove the PCZT is a canonical crossing.
  const beforeNu7 = 4_200_000
  const preTarget = beforeNu7 + 1
  const preRolling = preTarget - (preTarget % 34_560) + 69_120
  assert.throws(() => assertPcztConsensusPolicy('testnet', beforeNu7, 0x37a5165b, preRolling))
  assert.throws(() => assertPcztConsensusPolicy('testnet', beforeNu7, 0x37a5165b, preRolling + 1))
  const afterNu7 = 4_700_000
  const postTarget = afterNu7 + 1
  const postRolling = postTarget - (postTarget % 103_680) + 207_360
  assert.throws(() => assertPcztConsensusPolicy('testnet', afterNu7, 0x77190ad9, postRolling))
  assert.throws(() => assertPcztConsensusPolicy('testnet', afterNu7, 0x77190ad9, postRolling + 1))
  assert.throws(() =>
    assertPcztConsensusPolicy('testnet', 4_465_000, 0x37a5165b, 4_465_026 + 34_560)
  )
  const modulusBoundary = 120 * 34_560
  assert.throws(() =>
    assertPcztConsensusPolicy('testnet', modulusBoundary - 1, 0x37a5165b, modulusBoundary + 69_120)
  )
  assert.throws(() =>
    assertPcztConsensusPolicy('testnet', modulusBoundary - 1, 0x37a5165b, modulusBoundary + 34_560)
  )
})
