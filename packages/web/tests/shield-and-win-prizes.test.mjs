import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_BALLOONS, popOrder, prizeBoard } from '../src/shield-and-win/prizes.ts'

function campaign(overrides = {}) {
  return {
    id: 1,
    name: 'Shield & Win Week',
    status: 'ACTIVE',
    start_time: 0,
    end_time: 0,
    min_usd_value: '10',
    max_winners: 10,
    winner_count: 0,
    draw_count: 0,
    reward_amount: '0.1',
    reward_asset: 'ZEC',
    assets: [],
    ...overrides
  }
}

const poppedAt = board => board.popped.flatMap((popped, index) => (popped ? [index] : []))

test('every prize is a balloon, and none is popped before anyone wins', () => {
  const board = prizeBoard(campaign())
  assert.deepEqual(
    { total: board.total, taken: board.taken, left: board.left },
    { total: 10, taken: 0, left: 10 }
  )
  assert.deepEqual(poppedAt(board), [])
})

test('each win pops one more balloon and keeps the earlier ones popped', () => {
  let earlier = []
  for (let won = 1; won <= 10; won++) {
    const board = prizeBoard(campaign({ winner_count: won }))
    const now = poppedAt(board)
    assert.equal(now.length, won)
    assert.equal(board.left, 10 - won)
    assert.ok(earlier.every(index => now.includes(index)))
    earlier = now
  }
})

test('wins land around the board, the same way on every visit', () => {
  const first = poppedAt(prizeBoard(campaign({ winner_count: 3 })))
  assert.deepEqual(poppedAt(prizeBoard(campaign({ winner_count: 3 }))), first)
  // No two of the first three hits sit side by side (5 balloons a row)
  for (const a of first)
    for (const b of first) {
      if (a === b) continue
      const apart = Math.abs((a % 5) - (b % 5)) + Math.abs(Math.floor(a / 5) - Math.floor(b / 5))
      assert.ok(apart > 1, `${a} and ${b} are neighbours`)
    }
  const order = popOrder(10, 1)
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  )
})

test('a sold-out campaign has every balloon popped, and odd counts are kept in range', () => {
  assert.equal(prizeBoard(campaign({ status: 'SOLD_OUT', winner_count: 7 })).left, 0)
  assert.equal(prizeBoard(campaign({ winner_count: 25 })).taken, 10)
  assert.equal(prizeBoard(campaign({ winner_count: -2 })).taken, 0)
})

test('uncapped or very large prize pools keep the coin view', () => {
  assert.equal(prizeBoard(campaign({ max_winners: 0 })), null)
  assert.equal(prizeBoard(campaign({ max_winners: MAX_BALLOONS + 1 })), null)
  assert.equal(prizeBoard(campaign({ max_winners: 1 })).total, 1)
})
