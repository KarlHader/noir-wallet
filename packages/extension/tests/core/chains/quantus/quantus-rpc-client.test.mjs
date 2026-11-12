import { test } from 'node:test'
import { expect } from '@playwright/test'

import { QUANTUS_NETWORKS } from '../../../../src/config/networks.ts'
import {
  createQuantusRpcClient,
  QuantusRpcError
} from '../../../../src/infrastructure/chains/quantus/quantus-rpc-client.ts'

function jsonResult(body, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function harness(respond, config = {}) {
  const calls = []
  const client = createQuantusRpcClient(
    {
      chainId: QUANTUS_NETWORKS.testnet.chainId,
      rpcUrl: 'https://quantus.example',
      ...config
    },
    async (input, init) => {
      const body = JSON.parse(init.body)
      calls.push({ input, init, body })
      return respond(body, init)
    }
  )
  return { client, calls }
}

test.describe('Quantus broadcast RPC errors', () => {
  for (const [nodeMessage, nodeData, safeMessage] of [
    ['1010: Invalid Transaction: Stale', null, 'nonce is stale'],
    ['Invalid Transaction', 'BadProof', 'invalid signature'],
    ['Invalid Transaction', 'Transaction has a bad signature', 'invalid signature'],
    ['Invalid Transaction', 'Payment', 'insufficient funds for fees'],
    ['Invalid Transaction', 'Call', 'invalid transaction call'],
    ['Invalid Transaction', 'Custom(5)', 'rejected the extrinsic as invalid']
  ]) {
    test(`classifies ${safeMessage} without exposing node error data`, async () => {
      const state = harness(
        body =>
          new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              error: { code: 1010, message: nodeMessage, data: nodeData ?? 'sensitive RPC details' }
            }),
            { status: 200 }
          )
      )
      await expect(state.client.submitExtrinsic('0x088400')).rejects.toMatchObject({
        code: safeMessage === 'invalid signature' ? 'bad-signature' : 'rpc-error',
        message: expect.stringContaining(safeMessage)
      })
      expect(state.calls[0].body.method).toBe('author_submitExtrinsic')
    })
  }
})

test.describe('Quantus Substrate JSON-RPC client', () => {
  test('attests genesis hash and system_chain name', async () => {
    const state = harness(body => {
      if (body.method === 'chain_getBlockHash') {
        expect(body.params).toEqual([0])
        return jsonResult(body, QUANTUS_NETWORKS.testnet.genesisHash)
      }
      if (body.method === 'system_chain') {
        return jsonResult(body, 'Planck')
      }
      throw new Error(`unexpected method ${body.method}`)
    })

    await expect(state.client.assertExpectedChain()).resolves.toBeUndefined()
    expect(state.calls.map(call => call.body.method)).toEqual([
      'chain_getBlockHash',
      'system_chain'
    ])
  })

  test('reads the best head without using the finalized checkpoint', async () => {
    const state = harness(body => {
      expect(body.method).toBe('chain_getBlockHash')
      expect(body.params).toEqual([])
      return jsonResult(body, QUANTUS_NETWORKS.testnet.genesisHash)
    })
    await expect(state.client.getBestHead()).resolves.toBe(QUANTUS_NETWORKS.testnet.genesisHash)
  })

  test('rejects genesis mismatch', async () => {
    const state = harness(body =>
      body.method === 'chain_getBlockHash'
        ? jsonResult(body, QUANTUS_NETWORKS.mainnet.genesisHash)
        : jsonResult(body, 'Planck')
    )
    await expect(state.client.assertExpectedChain()).rejects.toMatchObject({
      code: 'chain-mismatch'
    })
    await expect(state.client.assertExpectedChain()).rejects.toBeInstanceOf(QuantusRpcError)
  })

  test('rejects system_chain name mismatch after genesis matches', async () => {
    const state = harness(body =>
      body.method === 'chain_getBlockHash'
        ? jsonResult(body, QUANTUS_NETWORKS.testnet.genesisHash)
        : jsonResult(body, 'Quantus')
    )
    await expect(state.client.assertExpectedChain()).rejects.toMatchObject({
      code: 'chain-mismatch'
    })
  })
})

const ACCOUNT_ADDRESS = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'

function accountInfoHex({ nonce, free, reserved }) {
  const bytes = Buffer.alloc(80)
  bytes.writeUInt32LE(nonce, 0)
  bytes.writeUInt32LE(0, 4)
  bytes.writeUInt32LE(1, 8)
  bytes.writeUInt32LE(0, 12)
  bytes.writeBigUInt64LE(free, 16)
  bytes.writeBigUInt64LE(reserved, 32)
  return `0x${bytes.toString('hex')}`
}

test.describe('Quantus account storage reads', () => {
  test('reads System.Account storage for the derived account ID', async () => {
    const state = harness(body => {
      expect(body.method).toBe('state_getStorage')
      expect(body.params).toHaveLength(1)
      return jsonResult(body, accountInfoHex({ nonce: 7, free: 5_000_000_000_000n, reserved: 42n }))
    })

    const info = await state.client.getAccountInfo(ACCOUNT_ADDRESS)
    expect(info).toEqual({ free: 5_000_000_000_000n, reserved: 42n, nonce: 7 })
    expect(state.calls[0].body.params[0]).toMatch(
      /^0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9[0-9a-f]{96}$/
    )
  })

  test('treats a missing storage entry as a funded-empty account', async () => {
    const state = harness(body => jsonResult(body, null))
    await expect(state.client.getAccountInfo(ACCOUNT_ADDRESS)).resolves.toEqual({
      free: 0n,
      reserved: 0n,
      nonce: 0
    })
  })

  test('rejects storage that does not match the supported AccountInfo layout', async () => {
    const state = harness(body => jsonResult(body, '0x0102030405'))
    await expect(state.client.getAccountInfo(ACCOUNT_ADDRESS)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  test('rejects a malformed address before issuing a storage request', async () => {
    const state = harness(body => jsonResult(body, null))
    await expect(state.client.getAccountInfo('qz')).rejects.toThrow(/address/)
    expect(state.calls).toHaveLength(0)
  })
})

test.describe('Quantus runtime version reads', () => {
  test('reads the runtime and transaction versions needed for extrinsic signing', async () => {
    const state = harness(body => {
      expect(body.method).toBe('state_getRuntimeVersion')
      return jsonResult(body, {
        specName: 'quantus-runtime',
        specVersion: 153,
        transactionVersion: 1
      })
    })
    await expect(state.client.getRuntimeVersion()).resolves.toEqual({
      specVersion: 153,
      transactionVersion: 1
    })
  })

  test('rejects a runtime version without numeric versions', async () => {
    const state = harness(body => jsonResult(body, { specName: 'quantus-runtime' }))
    await expect(state.client.getRuntimeVersion()).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })
})
