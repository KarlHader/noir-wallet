import { test } from 'node:test'
import { expect } from '@playwright/test'
import { verifyShareProof } from '../../../src/core/multisig/share-proof'

const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map(pair => parseInt(pair, 16)))

// Made by the iOS core (`share_scalar_prove`, `cargo test share_proof_vector -- --ignored --nocapture`).
const VECTORS = [
  {
    v: 'a4b5623cffc1fb6e936001655bfa2fb83585dcb5de07d4aecd39a075f474fa91',
    msg: '766563746f722d30',
    sig: '953ad958b7e7850747031699347834dfe4f0856629eddc2782cba495226de4073cb0fa07d44c7ea9453d1537efef2a6e39e24f1543f22a3c4a68fcaab6e22b27'
  },
  {
    v: '22edc2b2822ad8b21f161e7b7367146503ac62bb771207905dd3cef1d49f6c96',
    msg: '766563746f722d31',
    sig: '5214a3a26fd4d8d2e06c80c0e2b40b89a7d6f301959d15f876e60bc7e47592be68e29ab399f81d4c5361c58864af5bfb514995c88d7902901dd8886d13914038'
  }
]

test('verifies the proofs the phone core makes', () => {
  for (const vector of VECTORS) {
    expect(verifyShareProof(hex(vector.v), hex(vector.msg), hex(vector.sig))).toBe(true)
  }
})

test('rejects a changed message, signature, key or the other slot', () => {
  const [first, second] = VECTORS
  expect(verifyShareProof(hex(first.v), hex('00'), hex(first.sig))).toBe(false)
  const flipped = hex(first.sig)
  flipped[40] ^= 1
  expect(verifyShareProof(hex(first.v), hex(first.msg), flipped)).toBe(false)
  expect(verifyShareProof(hex(second.v), hex(first.msg), hex(first.sig))).toBe(false)
  expect(verifyShareProof(new Uint8Array(32).fill(0xff), hex(first.msg), hex(first.sig))).toBe(
    false
  )
  expect(verifyShareProof(hex(first.v), hex(first.msg), hex(first.sig).slice(0, 63))).toBe(false)
  expect(verifyShareProof(new Uint8Array(32), hex(first.msg), hex(first.sig))).toBe(false)
})
