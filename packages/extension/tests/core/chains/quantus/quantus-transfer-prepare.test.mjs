import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildQuantusWasmTransferRequest,
  parseQuantusCallSummary,
  parseSignedQuantusCall
} from '../../../../src/infrastructure/keyring/multichain/quantus-signing-client.ts'

const ADDRESS = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'
const GENESIS = `0x${'11'.repeat(32)}`
const ERA_BLOCK = `0x${'22'.repeat(32)}`

function request(overrides = {}) {
  return {
    chainId: 'quantus:mainnet',
    scheme: 'ml-dsa-87',
    accountIndex: 0,
    toAddress: ADDRESS,
    amountRaw: '1000',
    keepAlive: true,
    nonce: 1,
    tip: '0',
    period: 64,
    blockNumber: 128,
    genesisHash: GENESIS,
    blockHash: ERA_BLOCK,
    specVersion: 153,
    transactionVersion: 1,
    ...overrides
  }
}

describe('Quantus prepare request aligned with WASM QuantusTransferRequest', () => {
  it('emits exactly the fields the packaged engine accepts', () => {
    const built = buildQuantusWasmTransferRequest(request())
    assert.deepEqual(Object.keys(built).sort(), [
      'accountIndex',
      'allowImmortal',
      'amount',
      'blockHash',
      'blockNumber',
      'chainId',
      'genesisHash',
      'keepAlive',
      'nonce',
      'period',
      'recipient',
      'scheme',
      'specVersion',
      'tip',
      'transactionVersion'
    ])
    assert.equal(built.chainId, 'quantus:mainnet')
    assert.equal(built.recipient, ADDRESS)
    assert.equal(built.amount, '1000')
  })

  it('translates the Planck testnet reference at the engine boundary', () => {
    const built = buildQuantusWasmTransferRequest(request({ chainId: 'quantus:planck' }))
    assert.equal(built.chainId, 'quantus:dev')
  })

  it('rejects zero amounts, bad hashes, and immortal eras without opt-in', () => {
    assert.throws(() => buildQuantusWasmTransferRequest(request({ amountRaw: '0' })), /positive/)
    assert.throws(
      () => buildQuantusWasmTransferRequest(request({ genesisHash: `0x${'11'.repeat(31)}` })),
      /byte length/
    )
    assert.throws(() => buildQuantusWasmTransferRequest(request({ period: 0 })), /explicit opt-in/)
    assert.throws(
      () => buildQuantusWasmTransferRequest(request({ blockNumber: 0 })),
      /block number/
    )
    assert.throws(
      () => buildQuantusWasmTransferRequest(request({ chainId: 'quantus:dev' })),
      /Unsupported Quantus chain ID/
    )
  })

  it('accepts an immortal era when explicitly requested', () => {
    const built = buildQuantusWasmTransferRequest(request({ period: 0, allowImmortal: true }))
    assert.equal(built.allowImmortal, true)
  })
})

describe('Quantus WASM response parsing', () => {
  const summary = {
    chainId: 'quantus:mainnet',
    network: 'mainnet',
    genesisHash: `0x${'11'.repeat(32)}`,
    address: ADDRESS,
    accountId: `0x${'33'.repeat(32)}`,
    scheme: 'ml-dsa-87',
    nonce: 7,
    tip: '0',
    period: 64,
    blockNumber: 128,
    callHash: `0x${'44'.repeat(32)}`,
    callLength: 13,
    allowImmortal: false
  }

  it('parses a call summary', () => {
    assert.equal(parseQuantusCallSummary(summary).nonce, 7)
    assert.equal(parseQuantusCallSummary(summary).genesisHash, `0x${'11'.repeat(32)}`)
    assert.throws(() => parseQuantusCallSummary({ ...summary, extra: 1 }), /unknown field/)
  })

  it('parses a signed call response', () => {
    const signed = parseSignedQuantusCall({
      extrinsic: '0x8400',
      extrinsicHash: `0x${'55'.repeat(32)}`,
      callHash: `0x${'44'.repeat(32)}`,
      address: ADDRESS,
      accountId: `0x${'33'.repeat(32)}`,
      scheme: 'ml-dsa-65',
      nonce: 7
    })
    assert.equal(signed.scheme, 'ml-dsa-65')
    assert.throws(
      () =>
        parseSignedQuantusCall({
          extrinsic: '0x8400',
          extrinsicHash: `0x${'55'.repeat(31)}`,
          callHash: `0x${'44'.repeat(32)}`,
          address: ADDRESS,
          accountId: `0x${'33'.repeat(32)}`,
          scheme: 'ml-dsa-87',
          nonce: 7
        }),
      /byte length/
    )
  })
})
