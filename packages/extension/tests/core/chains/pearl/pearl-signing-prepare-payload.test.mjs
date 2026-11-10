import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parsePearlSigningPreparePayload } from '../../../../src/infrastructure/keyring/multichain/signing-adapter-pearl.ts'

const TESTNET = 'bip122:b0c86d0cd8825f4d72260d2de46f4704'
const PSBT = Buffer.from('psbt', 'utf8').toString('base64')

test('accepts the worker Pearl PSBT signing prepare contract without addressScheme', () => {
  expect(
    parsePearlSigningPreparePayload({
      kind: 'pearl-psbt',
      chainId: TESTNET,
      accountIndex: 0,
      psbt: PSBT
    })
  ).toEqual({
    kind: 'pearl-psbt',
    chainId: TESTNET,
    accountIndex: 0,
    psbt: PSBT
  })
})

test('rejects Pearl PSBT signing prepare payloads that include addressScheme', () => {
  expect(() =>
    parsePearlSigningPreparePayload({
      kind: 'pearl-psbt',
      chainId: TESTNET,
      addressScheme: 'pearl_p2tr',
      accountIndex: 0,
      psbt: PSBT
    })
  ).toThrow(/unknown field/)
})
