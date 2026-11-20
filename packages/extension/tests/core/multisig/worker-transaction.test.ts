import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '../../../src/lib/bytes'
import {
  finalizeSignedPczt,
  submitStoredTransaction
} from '../../../src/core/multisig/worker-transaction'
import { assertPcztConsensusPolicy } from '../../../src/core/multisig/pczt-review'

const txId = 'ab'.repeat(32)
const raw = Uint8Array.from([1, 2, 3, 4])
const receipt = {
  txId,
  rawTxSha256: bytesToHex(sha256(raw)),
  rawTxLen: raw.length,
  network: 'testnet' as const
}

test('finalization verifies the exact stored transaction before exposing a receipt', async () => {
  const calls: string[] = []
  const signed = { free: () => calls.push('signed free') }
  const proved = { serialize: () => Uint8Array.of(6) }
  const pczt = { from_bytes: () => signed } as any
  const tools = { shielded_sighash: () => new Uint8Array(32).fill(4) } as any
  const wallet = {
    pczt_prove: async (value: unknown) => {
      assert.equal(value, signed)
      calls.push('prove')
      return proved
    },
    pczt_store_detailed: async (value: unknown) => {
      assert.equal(value, proved)
      calls.push('store')
      return receipt
    },
    get_stored_transaction_bytes: async (value: string) => {
      assert.equal(value, txId)
      calls.push('read raw')
      return raw
    }
  } as any
  assert.deepEqual(
    await finalizeSignedPczt(
      { Pczt: pczt, PcztTools: tools },
      wallet,
      Uint8Array.of(5),
      'testnet',
      () => {},
      async () => {}
    ),
    receipt
  )
  assert.deepEqual(calls, ['prove', 'store', 'read raw'])
})

test('finalization rejects a changed stored transaction after WASM reports success', async () => {
  const pczt = { from_bytes: () => ({}) } as any
  const tools = { shielded_sighash: () => new Uint8Array(32).fill(4) } as any
  const wallet = {
    pczt_prove: async () => ({ serialize: () => Uint8Array.of(6) }),
    pczt_store_detailed: async () => receipt,
    get_stored_transaction_bytes: async () => Uint8Array.of(1, 2, 3, 5)
  } as any
  await assert.rejects(
    finalizeSignedPczt(
      { Pczt: pczt, PcztTools: tools },
      wallet,
      Uint8Array.of(5),
      'testnet',
      () => {},
      async () => {}
    ),
    /Stored multisig transaction/
  )
})

test('proof changing the signed transaction sighash cannot reach storage', async () => {
  let stored = false
  const wallet = {
    pczt_prove: async () => ({ serialize: () => Uint8Array.of(6) }),
    pczt_store_detailed: async () => {
      stored = true
      return receipt
    },
    get_stored_transaction_bytes: async () => raw
  } as any
  const tools = {
    shielded_sighash: (bytes: Uint8Array) => new Uint8Array(32).fill(bytes[0])
  } as any
  const pczt = { from_bytes: () => ({}) } as any
  await assert.rejects(
    finalizeSignedPczt(
      { ...pczt, Pczt: pczt, PcztTools: tools },
      wallet,
      Uint8Array.of(5),
      'testnet',
      () => {},
      async () => {}
    )
  )
  assert.equal(stored, false)
})

test('submission rechecks stored bytes and sends only the original txid once', async () => {
  let calls = 0
  const wallet = {
    get_stored_transaction_bytes: async () => raw,
    send_authorized_transactions: async (wire: Uint8Array) => {
      calls++
      assert.deepEqual(wire, Uint8Array.from(Buffer.from(txId, 'hex')).reverse())
      return {
        status: 'success',
        txIds: [txId],
        finalTxId: txId,
        transactions: [{ txId, status: 'submitted' }]
      }
    }
  } as any
  assert.deepEqual(await submitStoredTransaction(wallet, receipt, () => {}), {
    status: 'broadcast',
    txId
  })
  assert.equal(calls, 1)
  await assert.rejects(
    submitStoredTransaction(wallet, { ...receipt, rawTxSha256: '0'.repeat(64) }, () => {})
  )
  assert.equal(calls, 1)
})

test('credential loss during proof prevents storing the signed transaction', async () => {
  let authorized = true
  let stored = false
  const tools = { shielded_sighash: () => new Uint8Array(32).fill(4) } as any
  const pczt = { from_bytes: () => ({}) } as any
  const wallet = {
    pczt_prove: async () => {
      authorized = false
      return { serialize: () => Uint8Array.of(6) }
    },
    pczt_store_detailed: async () => {
      stored = true
      return receipt
    },
    get_stored_transaction_bytes: async () => raw
  } as any
  await assert.rejects(
    finalizeSignedPczt(
      { Pczt: pczt, PcztTools: tools },
      wallet,
      Uint8Array.of(5),
      'testnet',
      () => {
        if (!authorized) throw new Error('Credential changed')
      },
      async () => {}
    ),
    /Credential changed/
  )
  assert.equal(stored, false)
})

test('credential loss while reading stored bytes prevents network submission', async () => {
  let authorized = true
  let sent = false
  const wallet = {
    get_stored_transaction_bytes: async () => {
      authorized = false
      return raw
    },
    send_authorized_transactions: async () => {
      sent = true
      return {}
    }
  } as any
  await assert.rejects(
    submitStoredTransaction(wallet, receipt, () => {
      if (!authorized) throw new Error('Credential changed')
    }),
    /Credential changed/
  )
  assert.equal(sent, false)
})

test('a transaction that expires while proving is never stored', async () => {
  let tip = 4_134_000
  let stored = false
  const tools = { shielded_sighash: () => new Uint8Array(32).fill(4) } as any
  const pczt = { from_bytes: () => ({}) } as any
  const wallet = {
    pczt_prove: async () => {
      tip = 4_134_041
      return { serialize: () => Uint8Array.of(6) }
    },
    pczt_store_detailed: async () => {
      stored = true
      return receipt
    },
    get_stored_transaction_bytes: async () => raw
  } as any
  await assert.rejects(
    finalizeSignedPczt(
      { Pczt: pczt, PcztTools: tools },
      wallet,
      Uint8Array.of(5),
      'testnet',
      () => {},
      async () => assertPcztConsensusPolicy('testnet', tip, 0x37a5165b, 4_134_041)
    ),
    /PCZT review is unavailable/
  )
  assert.equal(stored, false)
})
