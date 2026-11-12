import assert from 'node:assert/strict'
import test from 'node:test'

const STARK_ORDER_BIT_LENGTH = 252
const SHIFT_BITS = 8 - (STARK_ORDER_BIT_LENGTH % 8)

function shiftThenTruncate(value) {
  assert.equal(SHIFT_BITS, 4)
  assert.ok(value >= 0n && value < 1n << 252n)
  const shifted = value << 4n
  assert.ok(shifted < 1n << 256n)
  return shifted >> BigInt(SHIFT_BITS)
}

test('a 252-bit Starknet hash shifted left by 4 and truncated to 252 bits is unchanged', () => {
  const values = [
    0n,
    1n,
    (1n << 251n) - 1n,
    1n << 251n,
    (1n << 252n) - 1n,
    0x47925e9fbb257d423cff737a67c87d38c652eba94ab17d6647d27b8df4f48ffn
  ]
  for (const value of values) {
    assert.equal(shiftThenTruncate(value), value)
  }
})
