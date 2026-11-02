import { test } from 'node:test'
import { expect } from '@playwright/test'
import { partitionVerboseTransactions } from '../../../src/core/wallet/transparent-history-cache'
import {
  fetchTransparentReceiveTransactions,
  mapVerboseTransactionToReceive,
  mergeTransactionsWithWasmHistory,
  mergeTransactionsWithTransparentReceives
} from '../../../src/core/wallet/transparent-history'
import type { VerboseTransaction } from '../../../src/lib/zcash-node-rpc'
import type { AccountData, Transaction } from '../../../src/types/wallet'

const txid = (character: string) => character.repeat(64)
const account = {
  addresses: { transparent: 'tmWallet' }
} as AccountData
const walletTransaction = (overrides: Partial<Transaction>): Transaction => ({
  id: 'tx_local',
  txHash: txid('f'),
  status: 'pending',
  type: 'send',
  amount: '0.01',
  to: 'tmWallet',
  from: 'u1Wallet',
  fromType: 'shielded',
  fee: '0.00015',
  timestamp: 1,
  network: 'mainnet',
  ...overrides
})

test.describe('Transparent history transaction cache', () => {
  test('reuses transaction details only after the requested confirmation depth', () => {
    const confirmed: VerboseTransaction = {
      txid: txid('a'),
      confirmations: 10
    }
    const confirming: VerboseTransaction = {
      txid: txid('b'),
      confirmations: 3
    }

    const result = partitionVerboseTransactions(
      [confirmed.txid, confirming.txid, txid('c')],
      {
        [confirmed.txid]: confirmed,
        [confirming.txid]: confirming
      },
      10
    )

    expect([...result.reusable.keys()]).toEqual([confirmed.txid])
    expect(result.txidsToFetch).toEqual([confirming.txid, txid('c')])
  })

  test('reuses mined transactions when the node supplies a height', () => {
    const mined: VerboseTransaction = {
      txid: txid('d'),
      height: 4_200_000
    }

    const result = partitionVerboseTransactions([mined.txid], {
      [mined.txid]: mined
    })

    expect(result.reusable.get(mined.txid)).toEqual(mined)
    expect(result.txidsToFetch).toEqual([])
  })

  test('uses wallet sync confirmations for a trusted transparent receive', () => {
    const transaction = mapVerboseTransactionToReceive(
      {
        txid: txid('e'),
        confirmations: 1,
        vout: [
          {
            valueZat: 100_000,
            n: 0,
            scriptPubKey: { addresses: [account.addresses.transparent!] }
          }
        ]
      },
      new Map(),
      account,
      'mainnet',
      'trusted',
      3
    )

    expect(transaction).toMatchObject({
      status: 'success',
      confirmations: 3,
      requiredConfirmations: 3
    })
  })

  test('ignores verbose transaction details whose txid differs from the requested hash', async () => {
    const originalFetch = globalThis.fetch
    const requestedTxid = txid('2')
    try {
      globalThis.fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string }
        const result =
          request.method === 'getaddresstxids'
            ? [requestedTxid]
            : {
                txid: txid('3'),
                confirmations: 12,
                vout: [
                  {
                    valueZat: 1_000_000,
                    scriptPubKey: { addresses: [account.addresses.transparent] }
                  }
                ]
              }
        return new Response(JSON.stringify({ result }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      await expect(
        fetchTransparentReceiveTransactions(account, 'mainnet', {
          baseUrl: 'https://node.example'
        })
      ).resolves.toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('repairs a stale local shielded self-transfer without duplicating its receive side', () => {
    const staleSend = walletTransaction({
      status: 'confirming',
      confirmations: 2,
      requiredConfirmations: 3
    })
    const wasmReceive = walletTransaction({
      id: `wasm_${staleSend.txHash}`,
      status: 'success',
      type: 'receive',
      fromType: 'transparent',
      confirmations: 3,
      requiredConfirmations: 3
    })

    const merged = mergeTransactionsWithWasmHistory([staleSend], [wasmReceive], [])

    expect(merged.transactions[0]).toEqual({
      ...staleSend,
      status: 'success',
      confirmations: 3
    })
    expect(merged.transactions).toHaveLength(1)
  })

  test('repairs failed local sends from mature WASM history but preserves unrelated terminal records', () => {
    const failedSend = walletTransaction({
      status: 'failed',
      failureReason: 'timeout',
      notified: true
    })
    const confirmedWasmSend = walletTransaction({
      id: `wasm_${failedSend.txHash}`,
      status: 'success',
      confirmations: 3,
      requiredConfirmations: 3
    })
    const recovered = mergeTransactionsWithWasmHistory([failedSend], [confirmedWasmSend], [])

    expect(recovered.transactions).toHaveLength(1)
    expect(recovered.transactions[0]).toMatchObject({
      id: failedSend.id,
      txHash: failedSend.txHash,
      status: 'success',
      confirmations: 3,
      notified: false
    })
    expect(recovered.transactions[0]).not.toHaveProperty('failureReason')

    const failedSwap = walletTransaction({ type: 'swap', status: 'failed' })
    expect(
      mergeTransactionsWithWasmHistory([failedSwap], [confirmedWasmSend], []).transactions[0].status
    ).toBe('failed')
  })

  test('preserves successful transparent receive state and repairs failed receive with mature evidence', () => {
    const hash = txid('9')
    const succeeded = walletTransaction({
      id: `rpc_treceive_${hash}`,
      txHash: hash,
      type: 'receive',
      fromType: 'transparent',
      status: 'success',
      confirmations: 10,
      depositAddress: 'deposit.near'
    })
    const staleReceive = { ...succeeded, status: 'confirming' as const, confirmations: 2 }
    const protectedSuccess = mergeTransactionsWithTransparentReceives([succeeded], [staleReceive])
    expect(protectedSuccess).toEqual([succeeded])

    const failedReceive = {
      ...succeeded,
      status: 'failed' as const,
      confirmations: undefined,
      failureReason: 'timeout',
      notified: true
    }
    const immature = { ...succeeded, status: 'confirming' as const, confirmations: 9 }
    expect(mergeTransactionsWithTransparentReceives([failedReceive], [immature])).toEqual([
      failedReceive
    ])

    const recovered = mergeTransactionsWithTransparentReceives([failedReceive], [succeeded])
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      id: failedReceive.id,
      status: 'success',
      confirmations: 10,
      depositAddress: 'deposit.near',
      notified: false
    })
    expect(recovered[0]).not.toHaveProperty('failureReason')
  })

  test('keeps one row for a confirmed shielded self-transfer', () => {
    const confirmedSend = walletTransaction({
      status: 'success',
      confirmations: 3,
      requiredConfirmations: 3
    })
    const staleReceive = walletTransaction({
      id: `rpc_treceive_${confirmedSend.txHash}`,
      status: 'confirming',
      type: 'receive',
      fromType: 'transparent',
      confirmations: 2,
      requiredConfirmations: 3
    })
    const staleWasmReceive = {
      ...staleReceive,
      id: `wasm_${confirmedSend.txHash}`
    }

    const merged = mergeTransactionsWithWasmHistory(
      [confirmedSend, staleReceive],
      [staleWasmReceive],
      [staleReceive]
    )

    expect(merged.transactions).toEqual([confirmedSend])
  })

  test('does not apply an unrelated send confirmation to an external receive', () => {
    const confirmedSend = walletTransaction({
      status: 'success',
      confirmations: 3,
      requiredConfirmations: 3
    })
    const externalReceive = walletTransaction({
      id: `rpc_treceive_${txid('e')}`,
      txHash: txid('e'),
      status: 'confirming',
      type: 'receive',
      fromType: 'transparent',
      confirmations: 3,
      requiredConfirmations: 10
    })

    const merged = mergeTransactionsWithWasmHistory([confirmedSend], [], [externalReceive])

    expect(merged.transactions).toEqual([confirmedSend, externalReceive])
  })

  test('repairs a stale shield amount from the shielded output and fee', () => {
    const staleShield = walletTransaction({
      status: 'confirming',
      type: 'shield',
      amount: '0.004814',
      confirmations: 1,
      requiredConfirmations: 3
    })
    const wasmShield = walletTransaction({
      id: `wasm_${staleShield.txHash}`,
      status: 'success',
      type: 'shield',
      amount: '0.00308475',
      fee: '0.0002',
      confirmations: 3,
      requiredConfirmations: 3
    })

    const merged = mergeTransactionsWithWasmHistory([staleShield], [wasmShield], [])

    expect(merged.transactions).toHaveLength(1)
    expect(merged.transactions[0]).toEqual({
      ...staleShield,
      status: 'success',
      confirmations: 3,
      amount: '0.00328475'
    })
  })

  test('keeps a multi-step TEX send as one logical activity entry and removes persisted steps', () => {
    const fundingHash = txid('a')
    const paymentHash = txid('b')
    const texSend = walletTransaction({
      txHash: paymentHash,
      amount: '0.0001',
      fee: '0.00025',
      chainHashes: [
        { chain: 'Zcash', hash: fundingHash },
        { chain: 'Zcash', hash: paymentHash }
      ]
    })
    const fundingStep = walletTransaction({
      id: `wasm_${fundingHash}`,
      txHash: fundingHash,
      amount: '0.0002'
    })
    const paymentStep = walletTransaction({
      id: `wasm_${paymentHash}`,
      txHash: paymentHash,
      amount: '0.0001'
    })

    const merged = mergeTransactionsWithWasmHistory(
      [texSend, fundingStep, paymentStep],
      [fundingStep, paymentStep],
      []
    )

    expect(merged.transactions).toEqual([texSend])
    expect(merged.newWasmTransactionCount).toBe(0)
  })
})
