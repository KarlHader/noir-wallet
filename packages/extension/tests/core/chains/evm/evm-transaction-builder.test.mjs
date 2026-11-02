import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  createAssetRegistry,
  createEvmBitcoinChainRegistry,
  getBundledEvmAssetDefinitions,
  parseChainId
} from '../../../../src/core/chains/registry/index.ts'
import {
  parseTransactionId,
  parseTransactionSegmentId
} from '../../../../src/core/transactions/domain/index.ts'
import {
  EvmRpcError,
  EvmTransactionError,
  assertEvmSigningSummaryMatchesPrepared,
  assertEvmTransferFresh,
  buildEvmCancelTransaction,
  buildEvmContractCall,
  buildEvmTransfer,
  createEvmSigningSummary,
  createEvmSigningPreparePayload,
  createEvmTransferGraph,
  parseEvmContractCallIntent,
  parsePreparedEvmTransfer,
  parseEvmTransferIntent
} from '../../../../src/infrastructure/chains/evm/index.ts'

const chainId = parseChainId('eip155:1').id
const chains = createEvmBitcoinChainRegistry('mainnet')
const assets = createAssetRegistry(chains, getBundledEvmAssetDefinitions('mainnet'))
const address = '0x1111111111111111111111111111111111111111'
const peaAddress = '0x33ff992c39043a03d207f2c3f4bbb6ef790fbed6'
const recipient = '0x2222222222222222222222222222222222222222'
const checksumRecipient = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const customToken = '0x3333333333333333333333333333333333333333'
const account = {
  id: 'chain-account:evm:2',
  scope: { keyDomainId: 'key-domain:0', accountId: 'account:2', chainId },
  derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/2" },
  identity: { kind: 'account-identifier', value: address },
  createdAt: 1
}

function transactionRpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getNativeBalance: async () => '1000000000000000000000',
    getPendingNonce: async () => '7',
    simulateCall: async () => '0x',
    estimateGas: async () => '21000',
    getMaximumPriorityFeePerGas: async () => '1000000000',
    getLatestBlockFee: async () => ({
      blockNumber: '100',
      baseFeePerGas: '2000000000'
    }),
    ...overrides
  }
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

test.describe('EVM transfer builder', () => {
  test('parses only the exact external transfer intent', () => {
    expect(
      parseEvmTransferIntent({
        assetId: 'eip155:1/slip44:60',
        recipient,
        amountRaw: '123'
      })
    ).toEqual({
      assetId: 'eip155:1/slip44:60',
      recipient,
      amountRaw: '123'
    })
    expect(() =>
      parseEvmTransferIntent({
        assetId: 'eip155:1/slip44:60',
        recipient,
        amountRaw: '123',
        data: '0x'
      })
    ).toThrow(/invalid fields/i)
    expect(() =>
      parseEvmTransferIntent({
        assetId: 'eip155:1/slip44:60',
        recipient,
        amountRaw: '0'
      })
    ).toThrow(/amount/i)
  })

  test('builds a chain-bound EIP-1559 native transfer after preflight', async () => {
    const calls = []
    const prepared = await buildEvmTransfer({
      chainId,
      chainAccount: account,
      assets,
      intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
      rpc: transactionRpc({
        assertExpectedChain: async () => calls.push('chain'),
        getPendingNonce: async from => {
          calls.push(['nonce', from])
          return '7'
        },
        simulateCall: async call => {
          calls.push(['simulate', call])
          return '0x'
        },
        estimateGas: async call => {
          calls.push(['estimate', call])
          return '21000'
        },
        getMaximumPriorityFeePerGas: async () => {
          calls.push('priority')
          return '1000000000'
        },
        getLatestBlockFee: async () => {
          calls.push('block')
          return { blockNumber: '100', baseFeePerGas: '2000000000' }
        }
      }),
      now: () => 1_800_000_000_000
    })

    expect(prepared).toEqual({
      kind: 'native-transfer',
      chainId: 'eip155:1',
      addressIndex: 2,
      from: address,
      assetId: 'eip155:1/slip44:60',
      recipient,
      amountRaw: '123',
      observedBlockNumber: '100',
      transaction: {
        type: 'eip1559',
        chainId: '1',
        nonce: '7',
        maxFeePerGas: '5000000000',
        maxPriorityFeePerGas: '1000000000',
        gasLimit: '21000',
        to: recipient,
        value: '123',
        input: '0x',
        accessList: []
      },
      createdAt: 1_800_000_000_000
    })
    expect(calls).toEqual([
      'chain',
      ['nonce', address],
      ['simulate', { from: address, to: recipient, valueRaw: '123', data: '0x' }],
      ['estimate', { from: address, to: recipient, valueRaw: '123', data: '0x' }],
      'priority',
      'block'
    ])
    expect(createEvmSigningPreparePayload(prepared)).toEqual({
      kind: 'evm-transaction',
      chainId: 'eip155:1',
      addressIndex: 2,
      transaction: prepared.transaction
    })

    const signingSummary = {
      schema: 'evm.transaction.v1',
      chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        transactionType: 'eip1559',
        from: address,
        to: recipient,
        nonce: '7',
        valueWei: '123',
        gasLimit: '21000',
        maximumFeeWei: '105000000000000',
        gasPriceWei: null,
        maxFeePerGasWei: '5000000000',
        maxPriorityFeePerGasWei: '1000000000',
        accessList: [],
        calldata: {
          encoding: 'hex',
          value: '0x',
          byteLength: 0,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        },
        methodSelector: null
      }
    }
    await expect(assertEvmSigningSummaryMatchesPrepared(prepared, signingSummary)).resolves.toBe(
      undefined
    )
    await expect(
      assertEvmSigningSummaryMatchesPrepared(prepared, {
        ...signingSummary,
        fields: { ...signingSummary.fields, valueWei: '124' }
      })
    ).rejects.toThrow(/does not match/i)

    const graph = createEvmTransferGraph({
      prepared,
      scope: account.scope,
      transactionId: parseTransactionId('transaction:evm:native-transfer'),
      segmentId: parseTransactionSegmentId('segment:evm:native-transfer'),
      chainAccountId: account.id,
      assets
    })
    expect(graph).toMatchObject({
      root: {
        kind: 'transfer',
        status: 'prepared',
        intent: {
          schemaVersion: 1,
          direction: 'outgoing',
          primaryAmount: {
            assetId: 'eip155:1/slip44:60',
            amountRaw: '123'
          },
          feeLimit: {
            assetId: 'eip155:1/slip44:60',
            amountRaw: '105000000000000'
          },
          sender: { chainId, address },
          recipient: { chainId, address: recipient }
        }
      },
      segments: [
        {
          status: 'prepared',
          target: { kind: 'onchain', chainId, chainAccountId: account.id }
        }
      ]
    })
  })

  test('builds a same-nonce self-transfer with replacement-safe fees for cancellation', async () => {
    const prepared = await buildEvmCancelTransaction({
      chainId,
      chainAccount: account,
      assets,
      original: {
        transactionHash: `0x${'a'.repeat(64)}`,
        nonce: '7',
        maxFeePerGasWei: '5000000000',
        maxPriorityFeePerGasWei: '1000000000'
      },
      rpc: transactionRpc({
        getTransactionLocation: async () => ({ status: 'pending' })
      }),
      now: () => 123
    })

    expect(prepared).toMatchObject({
      kind: 'cancel',
      from: address,
      recipient: address,
      amountRaw: '0',
      transaction: {
        nonce: '7',
        to: address,
        value: '0',
        input: '0x',
        maxPriorityFeePerGas: '1500000000',
        maxFeePerGas: '6500000000'
      }
    })
    await expect(
      buildEvmCancelTransaction({
        chainId,
        chainAccount: account,
        assets,
        original: {
          transactionHash: `0x${'a'.repeat(64)}`,
          nonce: '7',
          maxFeePerGasWei: '5000000000',
          maxPriorityFeePerGasWei: '1000000000'
        },
        rpc: transactionRpc({
          getTransactionLocation: async () => ({
            status: 'included',
            blockHash: '0x1',
            blockNumber: '1'
          })
        })
      })
    ).rejects.toThrow(/no longer pending/i)
  })

  test('permits an unknown original hash only at the current nonce and raises replacement fees', async () => {
    const original = {
      transactionHash: `0x${'a'.repeat(64)}`,
      nonce: '7',
      maxFeePerGasWei: '20000000000',
      maxPriorityFeePerGasWei: '5000000000'
    }
    const prepared = await buildEvmCancelTransaction({
      chainId,
      chainAccount: account,
      assets,
      original,
      allowUnknownAtNonce: true,
      feeSelection: { kind: 'tier', tier: 'standard' },
      rpc: transactionRpc({ getTransactionLocation: async () => ({ status: 'unknown' }) })
    })
    expect(BigInt(prepared.transaction.maxFeePerGas)).toBeGreaterThanOrEqual(22_500_000_000n)
    expect(BigInt(prepared.transaction.maxPriorityFeePerGas)).toBeGreaterThanOrEqual(5_625_000_000n)

    await expect(
      buildEvmCancelTransaction({
        chainId,
        chainAccount: account,
        assets,
        original,
        allowUnknownAtNonce: true,
        rpc: transactionRpc({
          getPendingNonce: async () => '6',
          getTransactionLocation: async () => ({ status: 'unknown' })
        })
      })
    ).rejects.toMatchObject({ code: 'stale-nonce' })
    await expect(
      buildEvmCancelTransaction({
        chainId,
        chainAccount: account,
        assets,
        original,
        rpc: transactionRpc({ getTransactionLocation: async () => ({ status: 'unknown' }) })
      })
    ).rejects.toMatchObject({ code: 'stale-nonce' })
  })

  test('binds PEA preflight and signing to the private execution address', async () => {
    const calls = []
    const prepared = await buildEvmTransfer({
      chainId,
      chainAccount: account,
      executionAccount: { kind: 'pea', address: peaAddress, addressIndex: 2 },
      assets,
      intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
      rpc: transactionRpc({
        getPendingNonce: async from => {
          calls.push(['nonce', from])
          return '7'
        },
        simulateCall: async call => {
          calls.push(['simulate', call])
          return '0x'
        },
        estimateGas: async call => {
          calls.push(['estimate', call])
          return '21000'
        },
        getNativeBalance: async from => {
          calls.push(['balance', from])
          return '1000000000000000000000'
        }
      })
    })

    expect(prepared.from).toBe(peaAddress)
    expect(calls).toEqual([
      ['nonce', peaAddress],
      ['balance', peaAddress],
      ['simulate', { from: peaAddress, to: recipient, valueRaw: '123', data: '0x' }],
      ['estimate', { from: peaAddress, to: recipient, valueRaw: '123', data: '0x' }]
    ])
    expect(createEvmSigningPreparePayload(prepared, 'private')).toEqual({
      kind: 'pea-evm-transaction',
      chainId: 'eip155:1',
      addressIndex: 2,
      transaction: prepared.transaction
    })
    const signerSummary = await createEvmSigningSummary(prepared)
    await expect(
      assertEvmSigningSummaryMatchesPrepared(prepared, {
        ...signerSummary,
        fields: {
          ...signerSummary.fields,
          from: '0x33FF992C39043A03D207f2C3f4BBB6Ef790FBEd6'
        }
      })
    ).resolves.toBeUndefined()
  })

  test('fails before PEA signing when native Gas and transaction value are insufficient', async () => {
    const error = await captureError(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        executionAccount: { kind: 'pea', address: peaAddress, addressIndex: 2 },
        assets,
        intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
        rpc: transactionRpc({ getNativeBalance: async () => '105000000000122' })
      })
    )

    expect(error).toBeInstanceOf(EvmTransactionError)
    expect(error.code).toBe('insufficient-funds')
    expect(error.message).toContain('Private Execution Address needs 1 more wei')
    expect(error.insufficientFunds).toEqual({
      requiredNativeBalanceRaw: '105000000000123',
      availableNativeBalanceRaw: '105000000000122',
      shortfallRaw: '1',
      maximumGasCostRaw: '105000000000000',
      transactionValueRaw: '123'
    })
  })

  test('builds, reviews, persists, and records a zero-value contract call', async () => {
    const calldata = '0x12345678aabbccdd'
    const intent = parseEvmContractCallIntent({
      chainId,
      contractAddress: recipient,
      valueRaw: '0',
      calldata
    })
    let simulatedCall
    const prepared = await buildEvmContractCall({
      chainId,
      chainAccount: account,
      assets,
      intent,
      rpc: transactionRpc({
        simulateCall: async call => {
          simulatedCall = call
          return '0x'
        },
        estimateGas: async () => '54321'
      }),
      now: () => 20
    })

    expect(simulatedCall).toEqual({
      from: address,
      to: recipient,
      valueRaw: '0',
      data: calldata
    })
    expect(prepared).toMatchObject({
      kind: 'contract-call',
      assetId: 'eip155:1/slip44:60',
      recipient,
      amountRaw: '0',
      transaction: { to: recipient, value: '0', input: calldata, gasLimit: '65186' }
    })
    expect(parsePreparedEvmTransfer(structuredClone(prepared))).toEqual(prepared)
    expect(() =>
      parsePreparedEvmTransfer({
        ...structuredClone(prepared),
        transaction: { ...structuredClone(prepared.transaction), input: '0x' }
      })
    ).toThrow(/contract call binding/i)

    const summary = await createEvmSigningSummary(prepared)
    expect(summary).toMatchObject({
      review: { level: 'caution', issues: [{ code: 'unrecognized-call' }] },
      fields: {
        to: recipient,
        valueWei: '0',
        methodSelector: '0x12345678',
        calldata: { value: calldata, byteLength: 8 }
      }
    })
    await expect(assertEvmSigningSummaryMatchesPrepared(prepared, summary)).resolves.toBeUndefined()

    const graph = createEvmTransferGraph({
      prepared,
      scope: account.scope,
      transactionId: parseTransactionId('transaction:evm:contract-call'),
      segmentId: parseTransactionSegmentId('segment:evm:contract-call'),
      chainAccountId: account.id,
      assets
    })
    expect(graph.root).toMatchObject({
      kind: 'contract-call',
      intent: {
        direction: 'contract',
        sender: { chainId, address },
        recipient: { chainId, address: recipient }
      }
    })
    expect(graph.root.intent?.primaryAmount).toBeUndefined()

    const approvalGraph = createEvmTransferGraph({
      prepared: {
        ...prepared,
        transaction: {
          ...prepared.transaction,
          input: `0x095ea7b3${'0'.repeat(24)}${recipient.slice(2)}${'0'.repeat(63)}1`
        }
      },
      scope: account.scope,
      transactionId: parseTransactionId('transaction:evm:approve'),
      segmentId: parseTransactionSegmentId('segment:evm:approve'),
      chainAccountId: account.id,
      assets
    })
    expect(approvalGraph.root.kind).toBe('approve')
  })

  test('rejects a reverting contract call before signing', async () => {
    const error = await captureError(
      buildEvmContractCall({
        chainId,
        chainAccount: account,
        assets,
        intent: {
          chainId,
          contractAddress: recipient,
          valueRaw: '0',
          calldata: '0xdeadbeef'
        },
        rpc: transactionRpc({
          simulateCall: async () => {
            throw new EvmRpcError('rpc-error', 'execution reverted')
          }
        })
      })
    )
    expect(error).toBeInstanceOf(EvmTransactionError)
    expect(error.code).toBe('simulation-failed')
  })

  test('encodes ERC-20 transfer calldata and requires a successful return value', async () => {
    let simulatedCall
    const prepared = await buildEvmTransfer({
      chainId,
      chainAccount: account,
      assets,
      intent: {
        assetId: `eip155:1/erc20:${usdc}`,
        recipient: checksumRecipient,
        amountRaw: '2000000'
      },
      rpc: transactionRpc({
        simulateCall: async call => {
          simulatedCall = call
          return `0x${'0'.repeat(63)}1`
        },
        estimateGas: async () => '65000'
      }),
      now: () => 1
    })

    const expectedData = `0xa9059cbb${checksumRecipient
      .slice(2)
      .toLowerCase()
      .padStart(64, '0')}${(2_000_000).toString(16).padStart(64, '0')}`
    expect(simulatedCall).toEqual({ from: address, to: usdc, valueRaw: '0', data: expectedData })
    expect(prepared).toMatchObject({
      kind: 'erc20-transfer',
      recipient: checksumRecipient,
      amountRaw: '2000000',
      transaction: { to: usdc, value: '0', input: expectedData, gasLimit: '78000' }
    })
    expect(parsePreparedEvmTransfer(structuredClone(prepared))).toEqual(prepared)

    const error = await captureError(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        assets,
        intent: { assetId: `eip155:1/erc20:${usdc}`, recipient, amountRaw: '1' },
        rpc: transactionRpc({ simulateCall: async () => `0x${'0'.repeat(64)}` })
      })
    )
    expect(error).toBeInstanceOf(EvmTransactionError)
    expect(error.code).toBe('simulation-failed')
  })

  test('rejects a token transfer with no native Gas before provider simulation', async () => {
    const calls = []
    const error = await captureError(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        executionAccount: { kind: 'pea', address: peaAddress, addressIndex: 2 },
        assets,
        intent: { assetId: `eip155:1/erc20:${usdc}`, recipient, amountRaw: '1' },
        rpc: transactionRpc({
          getPendingNonce: async () => {
            calls.push('nonce')
            return '7'
          },
          getNativeBalance: async () => {
            calls.push('balance')
            return '0'
          },
          simulateCall: async () => {
            calls.push('simulate')
            throw new EvmRpcError('rpc-error', 'provider-specific preflight failure')
          },
          estimateGas: async () => {
            calls.push('estimate')
            return '65000'
          }
        })
      })
    )

    expect(error).toBeInstanceOf(EvmTransactionError)
    expect(error.code).toBe('insufficient-funds')
    expect(error.insufficientFunds).toEqual({
      requiredNativeBalanceRaw: '1',
      availableNativeBalanceRaw: '0',
      shortfallRaw: '1',
      maximumGasCostRaw: '0',
      transactionValueRaw: '0'
    })
    expect(calls).toEqual(['nonce', 'balance'])
  })

  test('reports minimum Private funding details before a native value can be simulated', async () => {
    const error = await captureError(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        executionAccount: { kind: 'pea', address: peaAddress, addressIndex: 2 },
        assets,
        intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '123' },
        rpc: transactionRpc({ getNativeBalance: async () => '23' })
      })
    )

    expect(error).toBeInstanceOf(EvmTransactionError)
    expect(error.code).toBe('insufficient-funds')
    expect(error.insufficientFunds).toEqual({
      requiredNativeBalanceRaw: '123',
      availableNativeBalanceRaw: '23',
      shortfallRaw: '100',
      maximumGasCostRaw: '0',
      transactionValueRaw: '123'
    })
  })

  test('snapshots user-approved Token metadata for Activity after catalog removal', async () => {
    const customAssets = createAssetRegistry(chains, [
      ...getBundledEvmAssetDefinitions('mainnet'),
      {
        chainId,
        namespace: 'erc20',
        reference: customToken,
        kind: 'token',
        metadata: { name: 'Example Token', symbol: 'USDC', decimals: 18 },
        source: 'user-added',
        verification: 'user-approved'
      }
    ])
    const prepared = await buildEvmTransfer({
      chainId,
      chainAccount: account,
      assets: customAssets,
      intent: {
        assetId: `${chainId}/erc20:${customToken}`,
        recipient,
        amountRaw: '500000000000000000'
      },
      rpc: transactionRpc({
        simulateCall: async () => `0x${'0'.repeat(63)}1`,
        estimateGas: async () => '70000'
      }),
      now: () => 10
    })

    const graph = createEvmTransferGraph({
      prepared,
      scope: account.scope,
      transactionId: parseTransactionId('transaction:evm:custom-token'),
      segmentId: parseTransactionSegmentId('segment:evm:custom-token'),
      chainAccountId: account.id,
      assets: customAssets
    })
    expect(graph.root.intent?.primaryAmount).toEqual({
      assetId: `${chainId}/erc20:${customToken}`,
      amountRaw: '500000000000000000',
      metadata: { name: 'Example Token', symbol: 'USDC', decimals: 18 }
    })
  })

  test('rejects unknown assets, zero recipients, and invalid amounts before RPC', async () => {
    let rpcCalls = 0
    const rpc = transactionRpc({
      assertExpectedChain: async () => {
        rpcCalls += 1
      }
    })
    for (const intent of [
      { assetId: 'eip155:1/slip44:61', recipient, amountRaw: '1' },
      { assetId: 'eip155:1/slip44:60', recipient: `0x${'0'.repeat(40)}`, amountRaw: '1' },
      { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '0' }
    ]) {
      const error = await captureError(
        buildEvmTransfer({ chainId, chainAccount: account, assets, intent, rpc })
      )
      expect(error).toBeInstanceOf(EvmTransactionError)
      expect(error.code).toBe('invalid-intent')
    }
    expect(rpcCalls).toBe(0)
  })

  test('propagates cancellation but maps preflight reverts to simulation-failed', async () => {
    const cancellation = await captureError(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        assets,
        intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '1' },
        rpc: transactionRpc({
          simulateCall: async () => {
            throw new EvmRpcError('cancelled', 'cancelled')
          }
        })
      })
    )
    expect(cancellation).toBeInstanceOf(EvmRpcError)
    expect(cancellation.code).toBe('cancelled')

    const revert = await captureError(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        assets,
        intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '1' },
        rpc: transactionRpc({
          simulateCall: async () => {
            throw new EvmRpcError('rpc-error', 'reverted')
          }
        })
      })
    )
    expect(revert).toBeInstanceOf(EvmTransactionError)
    expect(revert.code).toBe('simulation-failed')

    const estimateRevert = await captureError(
      buildEvmTransfer({
        chainId,
        chainAccount: account,
        assets,
        intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '1' },
        rpc: transactionRpc({
          estimateGas: async () => {
            throw new EvmRpcError(
              'rpc-error',
              'execution reverted',
              { code: -32000, message: 'private revert detail' },
              'eth_estimateGas'
            )
          }
        })
      })
    )
    expect(estimateRevert).toBeInstanceOf(EvmTransactionError)
    expect(estimateRevert.code).toBe('simulation-failed')
    expect(estimateRevert.rpcFailure).toEqual({ code: -32000, method: 'eth_estimateGas' })
  })

  test('maps provider insufficient-balance failures without exposing provider details', async () => {
    for (const rpc of [
      transactionRpc({
        simulateCall: async () => {
          throw new EvmRpcError('rpc-error', 'rpc failed', {
            code: -32000,
            message: 'insufficient funds for gas * price + value: private provider detail'
          })
        }
      }),
      transactionRpc({
        estimateGas: async () => {
          throw new EvmRpcError('rpc-error', 'rpc failed', {
            code: -32000,
            message: 'transaction cost exceeds the account balance'
          })
        }
      })
    ]) {
      const error = await captureError(
        buildEvmTransfer({
          chainId,
          chainAccount: account,
          assets,
          intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '1' },
          rpc
        })
      )
      expect(error).toBeInstanceOf(EvmTransactionError)
      expect(error.code).toBe('insufficient-funds')
      expect(error.message).not.toContain('private provider detail')
    }
  })

  test('detects a stale pending nonce immediately before signing', async () => {
    const prepared = await buildEvmTransfer({
      chainId,
      chainAccount: account,
      assets,
      intent: { assetId: 'eip155:1/slip44:60', recipient, amountRaw: '1' },
      rpc: transactionRpc(),
      now: () => 1
    })

    await expect(assertEvmTransferFresh(prepared, transactionRpc())).resolves.toBeUndefined()
    const stale = await captureError(
      assertEvmTransferFresh(prepared, transactionRpc({ getPendingNonce: async () => '8' }))
    )
    expect(stale).toBeInstanceOf(EvmTransactionError)
    expect(stale.code).toBe('stale-nonce')
  })
})
