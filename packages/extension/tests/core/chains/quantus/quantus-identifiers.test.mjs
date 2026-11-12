import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseQuantusAddress } from '../../../../src/core/chains/quantus/identifiers.ts'

const VALID_ADDRESS = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'

describe('Quantus SS58 identifiers', () => {
  it('accepts a checksummed SS58 address with prefix 189', () => {
    assert.equal(parseQuantusAddress(VALID_ADDRESS), VALID_ADDRESS)
  })

  it('rejects truncated or wrong-prefix addresses', () => {
    // Too few decoded bytes for a Quantus SS58 account address.
    assert.throws(() => parseQuantusAddress('qz'), /encoding/)
    // Truncating base58 can keep decoded length while changing the prefix bytes.
    assert.throws(() => parseQuantusAddress(VALID_ADDRESS.slice(0, -1)), /prefix|checksum|encoding/)
  })
})
