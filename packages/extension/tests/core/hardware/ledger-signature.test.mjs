import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  normalizeLedgerTransparentSignature,
  parseLedgerPcztSignatures
} from '../../../src/lib/ledger/signature.ts'
import { bytesToBase64 } from '../../../src/lib/bytes.ts'

test('normalizes Ledger transparent recovery bit and rejects malformed signatures', () => {
  const raw = Uint8Array.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01])
  expect(normalizeLedgerTransparentSignature(raw)[0]).toBe(0x30)
  expect(raw[0]).toBe(0x31)
  expect(() => normalizeLedgerTransparentSignature(Uint8Array.from([0x31, 0x01]))).toThrow()
})

test('bounds and decodes only canonical Ledger signature groups', () => {
  const shielded = bytesToBase64(new Uint8Array(64))
  const transparent = bytesToBase64(
    Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01])
  )
  const signatures = {
    orchard: [{ spendAuthSig: shielded }],
    transparentInputSigs: [transparent],
    ironwood: []
  }
  expect(parseLedgerPcztSignatures(signatures)).toEqual(signatures)
  expect(() =>
    parseLedgerPcztSignatures({ ...signatures, orchard: [{ spendAuthSig: '!' }] })
  ).toThrow()
  expect(() => parseLedgerPcztSignatures({ ...signatures, extra: true })).toThrow()
})
