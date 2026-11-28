import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DRAW_ODDS,
  entryCopy,
  minimumOf,
  poolOf,
  shortDate,
  suggestedOf
} from '../src/home/campaignCopy.ts'

// The live campaign on 2026-11-28
const LIVE = {
  id: 1,
  name: 'Shield & Win Week',
  status: 'ACTIVE',
  start_time: 1795795200,
  end_time: 1796313600,
  min_usd_value: '10',
  max_winners: 10,
  winner_count: 0,
  draw_count: 11,
  reward_amount: '0.1',
  reward_asset: 'ZEC',
  assets: []
}

test('the ticket and the sheet name the whole prize pool', () => {
  const copy = entryCopy(LIVE)
  assert.equal(copy.title, 'Go Private, Win 1 ZEC')
  assert.equal(copy.heading, 'Shield $10. Win 1 ZEC.')
  assert.equal(
    copy.lede,
    'Shield your EVM assets ($10 minimum) for an instant draw every time. Your $10 stays in your own balance.'
  )
  assert.deepEqual(
    copy.steps.map(step => step.title),
    ['Get Noir', 'Have $10+ in Public', 'Shield → NEAR Confidential']
  )
  assert.equal(
    copy.steps[2].body,
    'At least $10 must arrive after fees (we suggest $12). Your draw runs instantly and the result shows in the app.'
  )
  assert.equal(copy.facts, `10 prizes of 0.1 ZEC · ${DRAW_ODDS} per draw · Ends Dec 3, 16:00 UTC`)
})

test('the pool multiplies decimal prizes exactly', () => {
  assert.equal(poolOf({ ...LIVE, reward_amount: '0.25', max_winners: 3 }), '0.75 ZEC')
  assert.equal(poolOf({ ...LIVE, reward_amount: '2', max_winners: 5 }), '10 ZEC')
  assert.equal(poolOf({ ...LIVE, reward_amount: '0.3', max_winners: 3 }), '0.9 ZEC')
  // No cap on winners: the ticket names one prize
  assert.equal(poolOf({ ...LIVE, max_winners: 0 }), '0.1 ZEC')
})

test('the suggested amount leaves the minimum after fees', () => {
  assert.equal(suggestedOf(LIVE), '$12')
  assert.equal(suggestedOf({ ...LIVE, min_usd_value: '25' }), '$30')
  assert.equal(suggestedOf({ ...LIVE, min_usd_value: '10.5' }), '$13')
})

test('a campaign without a minimum still reads well', () => {
  const copy = entryCopy({ ...LIVE, min_usd_value: '0', max_winners: 1 })
  assert.equal(minimumOf({ ...LIVE, min_usd_value: '0' }), null)
  assert.equal(copy.heading, 'Shield and win 0.1 ZEC.')
  assert.doesNotMatch(copy.lede + copy.steps.map(step => step.title + step.body).join(' '), /\$/)
  assert.match(copy.facts, /^1 prize of 0\.1 ZEC · /)
})

test('dates are short and in UTC', () => {
  assert.equal(shortDate(LIVE.end_time), 'Dec 3, 16:00 UTC')
})
