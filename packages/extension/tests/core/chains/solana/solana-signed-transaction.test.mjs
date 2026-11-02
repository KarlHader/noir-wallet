import { test } from 'node:test'
import { expect } from '@playwright/test'

import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import { parseSignedSolanaTransaction } from '../../../../src/infrastructure/chains/solana/solana-signed-transaction.ts'
import { buildSolanaNativeTransfer } from '../../../../src/infrastructure/chains/solana/solana-transaction-builder.ts'

const prepared = buildSolanaNativeTransfer({
  chainId: SOLANA_NETWORKS.devnet.chainId,
  sender: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
  recipient: 'SysvarRent111111111111111111111111111111111',
  recentBlockhash: 'SysvarC1ock11111111111111111111111111111111',
  lamports: '5000'
})

function signedTransaction() {
  const bytes = Buffer.from(prepared.transactionBase64, 'base64')
  bytes[64] = 1
  return bytes.toString('base64')
}

test('binds a signed Solana wire transaction to its first signature and message', () => {
  expect(parseSignedSolanaTransaction(signedTransaction(), `${'1'.repeat(63)}2`)).toEqual({
    transactionBase64: signedTransaction(),
    transactionHash: `${'1'.repeat(63)}2`,
    messageBase64: prepared.messageBase64
  })
})

test('rejects empty, mismatched and multi-signature Solana transactions', () => {
  expect(() => parseSignedSolanaTransaction(prepared.transactionBase64, '1'.repeat(64))).toThrow(
    /empty/
  )
  expect(() => parseSignedSolanaTransaction(signedTransaction(), '1'.repeat(64))).toThrow(/hash/)
  const multiple = Buffer.from(signedTransaction(), 'base64')
  multiple[0] = 2
  expect(() =>
    parseSignedSolanaTransaction(multiple.toString('base64'), `${'1'.repeat(63)}2`)
  ).toThrow(/one signature/)
})
