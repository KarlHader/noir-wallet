import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  nearImplicitAccountIdFromPublicKey,
  nearPublicKeyFromImplicitAccountId,
  parseNearAccountId,
  parseNearPublicKey
} from '../../../../src/core/chains/near/index.ts'

describe('NEAR identifiers', () => {
  it('accepts canonical named and implicit accounts', () => {
    assert.equal(parseNearAccountId('alice.near'), 'alice.near')
    assert.equal(parseNearAccountId('alice_test-1.testnet'), 'alice_test-1.testnet')
    assert.equal(parseNearAccountId('0'.repeat(64)), '0'.repeat(64))
  })

  it('derives the implicit account ID from the canonical ed25519 key bytes', () => {
    assert.equal(nearImplicitAccountIdFromPublicKey(`ed25519:${'1'.repeat(32)}`), '0'.repeat(64))
  })

  it('recovers the canonical ed25519 public key from an implicit account ID', () => {
    for (const publicKey of [
      `ed25519:${'1'.repeat(32)}`,
      'ed25519:3StNUx6QwKCgDxygKPgFXhuaz5TVpy3t3WFg6Q9h7j2D'
    ]) {
      assert.equal(
        nearPublicKeyFromImplicitAccountId(nearImplicitAccountIdFromPublicKey(publicKey)),
        publicKey
      )
    }
    assert.throws(() => nearPublicKeyFromImplicitAccountId('alice.testnet'), /implicit account ID/)
  })

  it('rejects malformed account IDs and public keys', () => {
    for (const value of ['A.near', '.alice', 'alice..near', 'a', 'a'.repeat(65)]) {
      assert.throws(() => parseNearAccountId(value), /canonical NEAR account ID/)
    }
    for (const value of ['secp256k1:1111', 'ed25519:0', 'ed25519:1111']) {
      assert.throws(() => parseNearPublicKey(value), /NEAR public key/)
    }
  })
})
