import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getVerifiedMultisigChainTip,
  assertFreshMultisigReview,
  prepareProductionMultisigPayment
} from '../../../src/core/multisig/production-review'
import { loadWalletWasm } from './helpers/vault-wasm'
import { readFile } from 'node:fs/promises'
import { hexToBytes } from '../../../src/lib/bytes'

const MAIN = 0x37a5165b
const bestblockhash = 'a'.repeat(64)
const valid = {
  chain: 'main',
  blocks: 3_428_200,
  headers: 3_428_200,
  estimatedheight: 3_428_201,
  verificationprogress: 0.9999997,
  bestblockhash,
  consensus: { nextblock: '37a5165b' }
}
const validHeader = () => ({
  hash: bestblockhash,
  height: valid.blocks,
  time: Math.floor(Date.now() / 1000) - 30
})
const node =
  (info: object, header: object = validHeader()) =>
  async (_url: unknown, options: RequestInit) => {
    const method = JSON.parse(String(options.body)).method
    return Response.json({ result: method === 'getblockheader' ? header : info })
  }

test('chain tip uses the node network identity and next-block consensus', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = node(valid)
    assert.deepEqual(await getVerifiedMultisigChainTip('mainnet', 'https://node.example'), {
      height: valid.blocks,
      consensusBranchId: MAIN
    })
    for (const patch of [
      { chain: 'test' },
      { blocks: '3428200' },
      { blocks: -1 },
      { headers: 3_428_199 },
      { estimatedheight: -1 },
      { verificationprogress: 0.5 },
      { initial_block_download_complete: false },
      { consensus: { nextblock: 'ffffffff' } }
    ]) {
      globalThis.fetch = node({ ...valid, ...patch })
      await assert.rejects(getVerifiedMultisigChainTip('mainnet', 'https://node.example'))
    }
    for (const header of [
      { ...validHeader(), hash: 'b'.repeat(64) },
      { ...validHeader(), height: valid.blocks - 1 },
      { ...validHeader(), time: Math.floor(Date.now() / 1000) - 1801 },
      { ...validHeader(), time: Math.floor(Date.now() / 1000) + 121 }
    ]) {
      globalThis.fetch = node(valid, header)
      await assert.rejects(getVerifiedMultisigChainTip('mainnet', 'https://node.example'))
    }
    globalThis.fetch = async (_url, options) => {
      const method = JSON.parse(String(options.body)).method
      return Response.json(
        method === 'getblockheader'
          ? { error: { code: -5, message: 'Missing header' } }
          : { result: valid }
      )
    }
    await assert.rejects(getVerifiedMultisigChainTip('mainnet', 'https://node.example'))
  } finally {
    globalThis.fetch = original
  }
})

test('fresh validation rejects a reviewed transaction once its expiry reaches the chain tip', async () => {
  const original = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async (_url, options) => {
      const method = JSON.parse(String(options.body)).method
      if (method === 'getblockheader')
        return Response.json({
          result: { ...validHeader(), height: calls === 1 ? 3_428_200 : 3_428_241 }
        })
      calls++
      const height = calls === 1 ? 3_428_200 : 3_428_241
      return Response.json({
        result: { ...valid, blocks: height, headers: height, estimatedheight: height + 1 }
      })
    }
    const reviewed = { expiryHeight: 3_428_241, consensusBranchId: MAIN }
    await assertFreshMultisigReview('mainnet', 'https://node.example', reviewed)
    await assert.rejects(assertFreshMultisigReview('mainnet', 'https://node.example', reviewed))
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = original
  }
})

test('production preparation reviews builder-returned PCZT bytes with real WASM', async () => {
  const wasm = await loadWalletWasm()
  const pczt = new Uint8Array(
    await readFile(new URL('./fixtures/ironwood_payment_change.pczt', import.meta.url))
  )
  const fvk = hexToBytes(
    '1111111111111111111111111111111111111111111111111111111111111111' +
      'f226a3f879ebe21abfafccb6c521ca749e63ac17fd2cd17870aa72de12d8330d' +
      '047c00ab5e0feca61a461858bb0b15d55f29763a0a282825acebd58698937d24'
  )
  const expectedRecipientRaw = hexToBytes(
    'cee87779926d17b1d3de99a6386bb76677b45939ede36b5e253314c1da24b9642d8474b8de3764accdb63b'
  )
  let freed = 0
  const wallet = {
    estimate_pczt_transfer_fee: async () => 15000n,
    pczt_create: async () => ({
      serialize: () => pczt.slice(),
      free: () => {
        freed++
      }
    })
  }
  const input = {
    accountId: 7,
    network: 'testnet' as const,
    recipient: 'synthetic-fixture-recipient',
    expectedRecipientRaw,
    amountZats: '100000',
    memo: '',
    marginalFeeZats: 5000,
    fvk,
    groupVerifyingKey: fvk.subarray(0, 32),
    chainTip: { height: 4_134_000, consensusBranchId: MAIN },
    assertAuthorized: () => {}
  }
  const result = await prepareProductionMultisigPayment(
    { PcztTools: wasm.PcztTools },
    wallet,
    input
  )
  assert.equal(result.summary.fee, '10000')
  assert.equal(result.reviewedChainPolicy.expiryHeight, 4_134_041)
  assert.deepEqual(result.pczt, pczt)
  assert.equal(freed, 1)
  await assert.rejects(
    prepareProductionMultisigPayment({ PcztTools: wasm.PcztTools }, wallet, {
      ...input,
      expectedRecipientRaw: new Uint8Array(43)
    })
  )
  assert.equal(freed, 2)
})
