import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUG_BOUNTY_URL,
  EXAMPLE,
  FIRST_ROUND_START,
  LEADERBOARD,
  PRIZES,
  ROUND_COUNT,
  ROUND_POOL,
  byRank,
  programState,
  roundSpan,
  roundsFrom,
  statusLine,
  submitNote,
  totalPoints
} from '../src/home/feedbackProgram.ts'

const START = '2026-12-01T16:00:00Z'

test('the configured first round start, once set, is a valid time', () => {
  if (FIRST_ROUND_START !== null) {
    assert.equal(roundsFrom(FIRST_ROUND_START).length, ROUND_COUNT)
  }
})

// A link without its scheme would turn into a path on this site
test('the configured links, once set, are full https addresses', () => {
  for (const url of [BUG_BOUNTY_URL, LEADERBOARD.href]) {
    if (url !== null) assert.equal(new URL(url).protocol, 'https:')
  }
})

test('rounds run back to back for two weeks each', () => {
  const rounds = roundsFrom(START)
  assert.deepEqual(
    rounds.map(round => [round.number, round.start.toISOString(), round.end.toISOString()]),
    [
      [1, '2026-12-01T16:00:00.000Z', '2026-12-15T16:00:00.000Z'],
      [2, '2026-12-15T16:00:00.000Z', '2026-12-29T16:00:00.000Z']
    ]
  )
  assert.equal(roundSpan(rounds[0]), 'Dec 1, 16:00 – Dec 15, 16:00 UTC')
})

test('no start, or an invalid one, means no rounds yet', () => {
  assert.deepEqual(roundsFrom(null), [])
  assert.deepEqual(roundsFrom('soon'), [])
  assert.deepEqual(programState([], new Date(START)), { phase: 'unscheduled' })
  assert.equal(statusLine({ phase: 'unscheduled' }), 'Round dates coming soon')
})

test('the program moves from upcoming through both rounds to over', () => {
  const rounds = roundsFrom(START)
  const at = iso => programState(rounds, new Date(iso))
  assert.equal(at('2026-12-01T15:59:59Z').phase, 'upcoming')
  assert.equal(statusLine(at('2026-12-01T15:59:59Z')), 'Round 1 opens Dec 1, 16:00 UTC')
  assert.equal(at(START).round?.number, 1)
  assert.equal(
    statusLine(at('2026-12-10T00:00:00Z')),
    'Round 1 of 2 is open · closes Dec 15, 16:00 UTC'
  )
  assert.equal(at('2026-12-15T16:00:00Z').round?.number, 2)
  assert.equal(at('2026-12-29T15:59:59Z').round?.number, 2)
  assert.equal(at('2026-12-29T16:00:00Z').phase, 'over')
})

test('the note under the chat button says when feedback counts', () => {
  const rounds = roundsFrom(START)
  const at = iso => submitNote(programState(rounds, new Date(iso)))
  assert.equal(submitNote({ phase: 'unscheduled' }), 'Feedback starts counting when Round 1 opens.')
  assert.equal(
    at('2026-11-30T00:00:00Z'),
    'Feedback starts counting when Round 1 opens on Dec 1, 16:00 UTC.'
  )
  assert.equal(at('2026-12-20T00:00:00Z'), null)
  assert.equal(
    at('2027-01-05T00:00:00Z'),
    'The trial has ended, so new feedback no longer counts toward a round.'
  )
})

test('the prizes add up to the round pool', () => {
  const cents = PRIZES.reduce((sum, prize) => sum + Math.round(Number(prize.amount) * 100), 0)
  assert.equal(cents, Math.round(Number(ROUND_POOL) * 100))
})

test('the ranking example matches the rules', () => {
  assert.deepEqual(
    EXAMPLE.map(entrant => totalPoints(entrant.counts)),
    [25, 25, 25, 23]
  )
  assert.deepEqual(
    [...EXAMPLE]
      .reverse()
      .sort(byRank)
      .map(entrant => entrant.user),
    ['A', 'B', 'C', 'D']
  )
})
