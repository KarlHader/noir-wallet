import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import {
  createNearRpcClient,
  NearRpcError
} from '../../../../src/infrastructure/chains/near/near-rpc-client.ts'

const blockHash = '11111111111111111111111111111111'
const publicKey = `ed25519:${'1'.repeat(32)}`

function jsonResult(body, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function harness(respond, config = {}) {
  const calls = []
  const client = createNearRpcClient(
    {
      chainId: NEAR_NETWORKS.testnet.chainId,
      rpcUrl: 'https://near.example',
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

test.describe('NEAR JSON-RPC client', () => {
  test('attests chain ID, full genesis hash, height and time', async () => {
    const state = harness(body => {
      if (body.method === 'status') {
        return jsonResult(body, {
          chain_id: 'testnet',
          sync_info: { latest_block_hash: blockHash, syncing: false }
        })
      }
      if (body.method === 'genesis_config') {
        return jsonResult(body, {
          chain_id: 'testnet',
          genesis_height: NEAR_NETWORKS.testnet.genesisHeight,
          genesis_time: NEAR_NETWORKS.testnet.genesisTime
        })
      }
      if (body.method === 'block') {
        return jsonResult(body, {
          header: {
            hash: NEAR_NETWORKS.testnet.genesisHash,
            height: NEAR_NETWORKS.testnet.genesisHeight
          }
        })
      }
      throw new Error('unexpected method')
    })

    await expect(state.client.assertExpectedChain()).resolves.toBeUndefined()
    expect(state.calls.map(call => call.body.method)).toEqual(['status', 'genesis_config', 'block'])
    expect(state.calls[0].input).toBe('https://near.example/')
    expect(state.calls[0].init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    })

    const mismatch = harness(body =>
      body.method === 'status'
        ? jsonResult(body, { chain_id: 'mainnet', sync_info: { latest_block_hash: blockHash } })
        : body.method === 'genesis_config'
          ? jsonResult(body, {
              chain_id: 'testnet',
              genesis_height: NEAR_NETWORKS.testnet.genesisHeight,
              genesis_time: NEAR_NETWORKS.testnet.genesisTime
            })
          : jsonResult(body, {
              header: {
                hash: NEAR_NETWORKS.testnet.genesisHash,
                height: NEAR_NETWORKS.testnet.genesisHeight
              }
            })
    )
    await expect(mismatch.client.assertExpectedChain()).rejects.toMatchObject({
      code: 'chain-mismatch'
    })
  })

  test('attests public endpoints without a three-request startup burst', async () => {
    let activeRequests = 0
    let maximumActiveRequests = 0
    const state = harness(async body => {
      activeRequests += 1
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
      await Promise.resolve()
      activeRequests -= 1
      if (body.method === 'status') {
        return jsonResult(body, {
          chain_id: 'testnet',
          sync_info: { latest_block_hash: blockHash, syncing: false }
        })
      }
      if (body.method === 'genesis_config') {
        return jsonResult(body, {
          chain_id: 'testnet',
          genesis_height: NEAR_NETWORKS.testnet.genesisHeight,
          genesis_time: NEAR_NETWORKS.testnet.genesisTime
        })
      }
      return jsonResult(body, {
        header: {
          hash: NEAR_NETWORKS.testnet.genesisHash,
          height: NEAR_NETWORKS.testnet.genesisHeight
        }
      })
    })

    await expect(state.client.assertExpectedChain()).resolves.toBeUndefined()
    expect(maximumActiveRequests).toBe(1)
  })

  test('reads exact final account and access-key state without unsafe numeric coercion', async () => {
    const state = harness(body => {
      if (body.params.request_type === 'view_account') {
        return jsonResult(body, {
          amount: '340282366920938463463374607431768211455',
          block_hash: blockHash,
          block_height: 42,
          code_hash: blockHash,
          locked: '7',
          storage_usage: 123,
          storage_paid_at: 0
        })
      }
      return jsonResult(body, {
        block_hash: blockHash,
        block_height: 43,
        nonce: 53_793_414_000_000,
        permission: {
          FunctionCall: {
            allowance: null,
            method_names: ['set_greeting'],
            receiver_id: 'contract.testnet'
          }
        }
      })
    })

    await expect(state.client.getAccount('alice.testnet')).resolves.toEqual({
      accountId: 'alice.testnet',
      amountRaw: '340282366920938463463374607431768211455',
      lockedRaw: '7',
      storageUsage: 123,
      codeHash: blockHash,
      blockHash,
      blockHeight: 42
    })
    await expect(state.client.getAccessKey('alice.testnet', publicKey)).resolves.toEqual({
      accountId: 'alice.testnet',
      publicKey,
      nonce: '53793414000000',
      permission: {
        kind: 'function-call',
        allowanceRaw: null,
        receiverId: 'contract.testnet',
        methodNames: ['set_greeting']
      },
      blockHash,
      blockHeight: 43
    })
    expect(state.calls.map(call => call.body.params)).toEqual([
      { request_type: 'view_account', finality: 'final', account_id: 'alice.testnet' },
      {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: 'alice.testnet',
        public_key: publicKey
      }
    ])

    const unsafeNonce = harness(body =>
      jsonResult(body, {
        block_hash: blockHash,
        block_height: 1,
        nonce: 9_007_199_254_740_992,
        permission: 'FullAccess'
      })
    )
    await expect(unsafeNonce.client.getAccessKey('alice.testnet', publicKey)).rejects.toMatchObject(
      {
        code: 'invalid-response'
      }
    )
  })

  test('maps both structured RPC and in-result missing account/access-key responses to null', async () => {
    const structured = harness(
      body =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              name: 'HANDLER_ERROR',
              cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: 'missing.testnet' } },
              code: -32000,
              message: 'Server error',
              data: 'account missing.testnet does not exist while viewing'
            }
          })
        )
    )
    await expect(structured.client.getAccount('missing.testnet')).resolves.toBeNull()

    const inline = harness(body =>
      jsonResult(body, {
        block_hash: blockHash,
        block_height: 1,
        error: `access key ${publicKey} does not exist while viewing`,
        logs: []
      })
    )
    await expect(inline.client.getAccessKey('alice.testnet', publicKey)).resolves.toBeNull()
  })

  test('reads final block, gas price and canonical NEP-141 raw balance', async () => {
    const state = harness(body => {
      if (body.method === 'block') {
        return jsonResult(body, {
          author: 'validator.testnet',
          header: {
            hash: blockHash,
            height: 99,
            timestamp_nanosec: '18446744073709551615',
            gas_price: '100000000'
          }
        })
      }
      if (body.method === 'gas_price') return jsonResult(body, { gas_price: '100000000' })
      const encoded = [...Buffer.from(JSON.stringify('20010000000000000000001'))]
      return jsonResult(body, {
        block_hash: blockHash,
        block_height: 100,
        logs: [],
        result: encoded
      })
    })

    await expect(state.client.getFinalBlock()).resolves.toEqual({
      hash: blockHash,
      height: 99,
      timestampNanosec: '18446744073709551615',
      gasPriceRaw: '100000000'
    })
    await expect(state.client.getGasPrice()).resolves.toBe('100000000')
    await expect(
      state.client.getFungibleTokenBalance('wrap.testnet', 'alice.testnet')
    ).resolves.toEqual({
      contractId: 'wrap.testnet',
      accountId: 'alice.testnet',
      amountRaw: '20010000000000000000001',
      blockHash,
      blockHeight: 100
    })
    expect(state.calls.at(-1).body.params).toEqual({
      request_type: 'call_function',
      finality: 'final',
      account_id: 'wrap.testnet',
      method_name: 'ft_balance_of',
      args_base64: Buffer.from(JSON.stringify({ account_id: 'alice.testnet' })).toString('base64')
    })
  })

  test('reads the final protocol costs required for a native transfer fee quote', async () => {
    const state = harness(body =>
      jsonResult(body, {
        chain_id: 'testnet',
        protocol_version: 85,
        runtime_config: {
          min_gas_purchase_price: '1000000000',
          storage_amount_per_byte: '10000000000000000000',
          transaction_costs: {
            action_receipt_creation_config: {
              execution: 108059500000,
              send_not_sir: 108059500000,
              send_sir: 108059500000
            },
            action_creation_config: {
              transfer_cost: {
                execution: 115123062500,
                send_not_sir: 115123062500,
                send_sir: 115123062500
              }
            }
          }
        }
      })
    )

    await expect(state.client.getNativeTransferCostConfig()).resolves.toEqual({
      chainId: 'testnet',
      minGasPurchasePriceRaw: '1000000000',
      storageAmountPerByteRaw: '10000000000000000000',
      actionReceiptCreation: {
        executionGas: '108059500000',
        sendNotSirGas: '108059500000',
        sendSirGas: '108059500000'
      },
      transfer: {
        executionGas: '115123062500',
        sendNotSirGas: '115123062500',
        sendSirGas: '115123062500'
      }
    })
    expect(state.calls[0].body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'EXPERIMENTAL_protocol_config',
      params: { finality: 'final' }
    })

    const mismatch = harness(body =>
      jsonResult(body, {
        chain_id: 'mainnet',
        runtime_config: {
          min_gas_purchase_price: '1000000000',
          storage_amount_per_byte: '10000000000000000000',
          transaction_costs: {
            action_receipt_creation_config: {
              execution: 1,
              send_not_sir: 1,
              send_sir: 1
            },
            action_creation_config: {
              transfer_cost: { execution: 1, send_not_sir: 1, send_sir: 1 }
            }
          }
        }
      })
    )
    await expect(mismatch.client.getNativeTransferCostConfig()).rejects.toMatchObject({
      code: 'chain-mismatch'
    })
  })

  test('broadcasts only a bounded canonical signed transaction', async () => {
    const transactionHash = 'SysvarC1ock11111111111111111111111111111111'
    const state = harness(body => jsonResult(body, transactionHash))

    await expect(state.client.broadcastSignedTransaction('AQ==')).resolves.toBe(transactionHash)
    expect(state.calls[0].body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'broadcast_tx_async',
      params: ['AQ==']
    })
    await expect(state.client.broadcastSignedTransaction('not-base64')).rejects.toThrow(
      /signed transaction/
    )
    await expect(
      state.client.broadcastSignedTransaction(Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'))
    ).rejects.toThrow(/signed transaction/)
  })

  test('returns a committed NEAR outcome for dApp sign-and-send requests', async () => {
    const outcome = {
      transaction: { hash: blockHash, signer_id: 'alice.testnet' },
      status: { SuccessValue: '' },
      receipts_outcome: []
    }
    const state = harness(body => jsonResult(body, outcome))

    await expect(state.client.broadcastSignedTransactionAndWait('AQ==')).resolves.toEqual(outcome)
    expect(state.calls[0].body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'broadcast_tx_commit',
      params: ['AQ==']
    })
  })

  test('tracks NEAR transaction finality and execution failure by hash and signer', async () => {
    const confirming = harness(body =>
      jsonResult(body, {
        final_execution_status: 'EXECUTED_OPTIMISTIC',
        transaction: { hash: blockHash },
        status: { SuccessValue: '' }
      })
    )
    await expect(
      confirming.client.getTransactionStatus(blockHash, 'alice.testnet')
    ).resolves.toEqual({ status: 'confirming' })
    expect(confirming.calls[0].body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tx',
      params: {
        tx_hash: blockHash,
        sender_account_id: 'alice.testnet',
        wait_until: 'NONE'
      }
    })

    for (const [status, execution] of [
      ['final', { SuccessValue: '' }],
      ['failed', { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: {} } } } }]
    ]) {
      const state = harness(body =>
        jsonResult(body, {
          final_execution_status: 'FINAL',
          transaction: { hash: blockHash },
          status: execution
        })
      )
      await expect(state.client.getTransactionStatus(blockHash, 'alice.testnet')).resolves.toEqual({
        status
      })
    }

    const unknown = harness(
      body =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: {
              name: 'HANDLER_ERROR',
              cause: { name: 'UNKNOWN_TRANSACTION' },
              code: -32000,
              message: 'Server error'
            }
          })
        )
    )
    await expect(unknown.client.getTransactionStatus(blockHash, 'alice.testnet')).resolves.toEqual({
      status: 'unknown'
    })

    const malformed = harness(body =>
      jsonResult(body, {
        final_execution_status: 'FINAL',
        transaction: { hash: blockHash },
        status: { SuccessReceiptId: blockHash }
      })
    )
    await expect(
      malformed.client.getTransactionStatus(blockHash, 'alice.testnet')
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('rejects malformed endpoints, oversized responses and non-canonical token balances', async () => {
    for (const rpcUrl of [
      'http://near.example',
      'https://user:pass@near.example',
      'https://near.example?key=secret'
    ]) {
      expect(() => createNearRpcClient({ chainId: NEAR_NETWORKS.testnet.chainId, rpcUrl })).toThrow(
        /credential-free HTTPS/
      )
    }

    const oversized = harness(
      body =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'x'.repeat(2_000) }), {
          headers: { 'content-length': '2100' }
        }),
      { maximumResponseBytes: 1_024 }
    )
    await expect(oversized.client.getGasPrice()).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const floatBalance = harness(body =>
      jsonResult(body, {
        block_hash: blockHash,
        block_height: 1,
        logs: [],
        result: [...Buffer.from(JSON.stringify('01'))]
      })
    )
    await expect(
      floatBalance.client.getFungibleTokenBalance('wrap.testnet', 'alice.testnet')
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('maps cancellation, timeout, HTTP rate limits and malformed RPC errors', async () => {
    const cancelled = harness(() => {
      throw new Error('should not run')
    })
    const controller = new AbortController()
    controller.abort()
    await expect(cancelled.client.getFinalBlock(controller.signal)).rejects.toMatchObject({
      code: 'cancelled'
    })

    const timeout = harness(
      (_body, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      { timeoutMs: 1 }
    )
    await expect(timeout.client.getFinalBlock()).rejects.toMatchObject({ code: 'timeout' })

    const limited = harness(() => new Response('', { status: 429 }))
    await expect(limited.client.getGasPrice()).rejects.toMatchObject({ code: 'rate-limited' })

    const malformed = harness(
      body =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 'bad', message: true } })
        )
    )
    await expect(malformed.client.getGasPrice()).rejects.toEqual(
      new NearRpcError('invalid-response', 'Invalid NEAR RPC error response')
    )
  })
})
