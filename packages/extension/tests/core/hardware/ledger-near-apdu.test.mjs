import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ledgerNearPublicKeyParameters } from '../../../src/lib/ledger/near-model.ts'

it('uses the NEAR public-key display flag and five hardened big-endian indexes', () => {
  // Official near-ledger-rs get_public_key_with_display_flag protocol vector.
  const path = "m/44'/397'/0'/0'/1'"
  const confirmed = ledgerNearPublicKeyParameters(path, true)
  const silent = ledgerNearPublicKeyParameters(path, false)
  assert.equal(confirmed.p1, 0)
  assert.equal(silent.p1, 1)
  assert.equal(
    Buffer.from(confirmed.data).toString('hex'),
    '8000002c8000018d800000008000000080000001'
  )
  assert.deepEqual(silent.data, confirmed.data)
  assert.equal(
    Buffer.from(ledgerNearPublicKeyParameters("m/44'/397'/0'/0'/2147483647'", false).data).toString(
      'hex'
    ),
    '8000002c8000018d8000000080000000ffffffff'
  )
  assert.throws(
    () => ledgerNearPublicKeyParameters("m/44'/397'/0'/0'/2147483648'", true),
    /canonical/
  )
  assert.throws(() => ledgerNearPublicKeyParameters("m/44'/397'/0'/0'/1", true), /path/)
})
