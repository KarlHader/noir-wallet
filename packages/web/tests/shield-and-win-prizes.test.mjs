import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_PRIZE_BOXES, prizeBoard } from '../src/shield-and-win/prizes.ts'

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

const openAt = board => board.opened.flatMap((open, index) => (open ? [index] : []))

test('every prize is a sealed box until someone wins, and the first one is in the draw', () => {
  const board = prizeBoard(campaign())
  assert.deepEqual(
    { total: board.total, taken: board.taken, left: board.left, current: board.current },
    { total: 10, taken: 0, left: 10, current: 0 }
  )
  assert.deepEqual(openAt(board), [])
})

test('wins open the boxes from the left, and the next box moves into the draw', () => {
  for (let won = 1; won < 10; won++) {
    const board = prizeBoard(campaign({ winner_count: won }))
    assert.deepEqual(
      openAt(board),
      Array.from({ length: won }, (_, index) => index)
    )
    assert.equal(board.left, 10 - won)
    assert.equal(board.current, won)
  }
})

test('no box is in the draw once the campaign is sold out, over or not started', () => {
  const soldOut = prizeBoard(campaign({ status: 'SOLD_OUT', winner_count: 7 }))
  assert.equal(soldOut.left, 0)
  assert.equal(soldOut.current, null)
  const lastPrize = prizeBoard(campaign({ winner_count: 10 }))
  assert.equal(lastPrize.current, null)
  const ended = prizeBoard(campaign({ status: 'ENDED', winner_count: 4 }))
  assert.deepEqual({ taken: ended.taken, current: ended.current }, { taken: 4, current: null })
  assert.equal(prizeBoard(campaign({ status: 'UPCOMING' })).current, null)
})

test('odd winner counts are kept in range', () => {
  assert.equal(prizeBoard(campaign({ winner_count: 25 })).taken, 10)
  assert.equal(prizeBoard(campaign({ winner_count: -2 })).taken, 0)
})

test('uncapped or larger prize pools keep the coin view', () => {
  assert.equal(prizeBoard(campaign({ max_winners: 0 })), null)
  assert.equal(prizeBoard(campaign({ max_winners: MAX_PRIZE_BOXES + 1 })), null)
  assert.equal(prizeBoard(campaign({ max_winners: 1 })).total, 1)
})
