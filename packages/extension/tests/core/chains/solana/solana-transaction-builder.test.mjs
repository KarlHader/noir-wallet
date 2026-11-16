import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import { buildSolanaNativeTransfer } from '../../../../src/infrastructure/chains/solana/solana-transaction-builder.ts'

const sender = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const recipient = 'SysvarRent111111111111111111111111111111111'
const blockhash = 'SysvarC1ock11111111111111111111111111111111'

function readShortVec(bytes, cursor) {
  let value = 0
  let shift = 0
  while (true) {
    const byte = bytes[cursor.offset]
    cursor.offset += 1
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
}

test.describe('Solana native transfer builder', () => {
  test('builds a canonical one-signer legacy SystemProgram transfer', () => {
    const built = buildSolanaNativeTransfer({
      chainId: SOLANA_NETWORKS.devnet.chainId,
      sender,
      recipient,
      recentBlockhash: blockhash,
      lamports: '5000'
    })

    const transaction = Buffer.from(built.transactionBase64, 'base64')
    const message = Buffer.from(built.messageBase64, 'base64')
    expect(transaction.length).toBeLessThanOrEqual(1_232)
    expect(transaction.subarray(65)).toEqual(message)

    const cursor = { offset: 0 }
    expect(readShortVec(transaction, cursor)).toBe(1)
    expect(transaction.subarray(cursor.offset, cursor.offset + 64)).toEqual(Buffer.alloc(64))
    cursor.offset += 64
    expect([...transaction.subarray(cursor.offset, cursor.offset + 3)]).toEqual([1, 0, 1])
    cursor.offset += 3
    expect(readShortVec(transaction, cursor)).toBe(3)
    cursor.offset += 32 * 3 + 32
    expect(readShortVec(transaction, cursor)).toBe(1)
    expect(transaction[cursor.offset]).toBe(2)
    cursor.offset += 1
    expect(readShortVec(transaction, cursor)).toBe(2)
    expect([...transaction.subarray(cursor.offset, cursor.offset + 2)]).toEqual([0, 1])
    cursor.offset += 2
    expect(readShortVec(transaction, cursor)).toBe(12)
    expect(transaction.readUInt32LE(cursor.offset)).toBe(2)
    expect(transaction.readBigUInt64LE(cursor.offset + 4)).toBe(5_000n)

    expect(built).toMatchObject({
      sender,
      recipient,
      lamports: '5000',
      recentBlockhash: blockhash
    })
  })

  test('rejects unsafe amounts, invalid addresses and self transfers', () => {
    const base = {
      chainId: SOLANA_NETWORKS.devnet.chainId,
      sender,
      recipient,
      recentBlockhash: blockhash,
      lamports: '1'
    }

    expect(() => buildSolanaNativeTransfer({ ...base, lamports: '0' })).toThrow(/positive/)
    expect(() => buildSolanaNativeTransfer({ ...base, lamports: '18446744073709551616' })).toThrow(
      /u64/
    )
    expect(() => buildSolanaNativeTransfer({ ...base, recipient: sender })).toThrow(/different/)
    expect(() => buildSolanaNativeTransfer({ ...base, recipient: 'not-base58' })).toThrow(
      /public key/
    )
    expect(() => buildSolanaNativeTransfer({ ...base, chainId: 'near:testnet' })).toThrow(
      /chain ID/
    )
  })
})
