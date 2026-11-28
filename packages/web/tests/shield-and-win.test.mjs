import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  ShieldWinApiError,
  claimReward,
  getAllEntries,
  getCampaigns,
  getEntries,
  selectCampaign,
  shieldWinApiBase
} from '../src/shield-and-win/api.ts'
import { assetInfo, assetLabel, getAssetLabels } from '../src/shield-and-win/asset-label.ts'
import { claimMessage, isTransparentZcashAddress, utf8ToHex } from '../src/shield-and-win/claim.ts'
import {
  ENTRIES_LIST_POLL_INTERVAL_MS,
  ENTRY_POLL_INTERVAL_MS,
  ENTRY_POLL_LIMIT,
  REWARD_POLL_INTERVAL_MS,
  REWARD_POLL_LIMIT,
  boardView,
  campaignStatusWord,
  closedCampaignHint,
  deadlineLabel,
  entryCopy,
  entryView,
  formatEntryUsd,
  latestEntry,
  rewardTransactionUrl,
  sortedEntries,
  unclaimedWins
} from '../src/shield-and-win/view.ts'
import {
  connectTransparentAddress,
  detectNoirWallet,
  detectZcashProvider,
  disconnectZcash,
  isUnsupportedZcashAccount,
  readAccounts,
  readConnectedTransparentAddress,
  requestAccount,
  revokeAccount,
  signClaim,
  subscribeAccounts,
  walletErrorMessage
} from '../src/shield-and-win/wallet.ts'
import {
  clearCachedCampaign,
  readCachedCampaign,
  writeCachedCampaign
} from '../src/shield-and-win/campaign-cache.ts'

const BANNED = ['$10', '1 ZEC', 'shielded']
const ODDS_LITERAL = '1 / 444'

function campaign(overrides = {}) {
  return {
    id: 1,
    name: 'Round',
    status: 'ACTIVE',
    start_time: 1_760_000_000,
    end_time: 1_762_600_000,
    min_usd_value: '25.50',
    max_winners: 100,
    winner_count: 3,
    draw_count: 57,
    reward_amount: '0.20',
    reward_asset: 'ZEC',
    assets: [{ asset_id: 'nep141:usdt.tether-token.near', decimal: 6 }],
    ...overrides
  }
}

function entry(overrides = {}) {
  return {
    id: 12,
    operation_id: 98765,
    campaign_id: 1,
    destination_asset: 'nep141:usdt.tether-token.near',
    usd_value: '25.50',
    draw_result: 'WON',
    reward_amount: '0.20',
    reward_asset: 'ZEC',
    reward_status: 'UNCLAIMED',
    shield_completed_at: 1_760_000_123_000,
    ...overrides
  }
}

function address(prefix, length) {
  return prefix + '1'.repeat(length - prefix.length)
}

function claimInput(overrides = {}) {
  return {
    entry_id: 12,
    wallet_address: `0x${'aB'.repeat(20)}`,
    zcash_address: address('t1', 35),
    signature: `0x${'cd'.repeat(65)}`,
    ...overrides
  }
}

function jsonResponse(body, status = 200) {
  return Response.json(body, { status })
}

test('selectCampaign prefers the first active campaign, then the newest item', () => {
  const newestEnded = campaign({ id: 9, status: 'ENDED' })
  const active = campaign({ id: 4, status: 'ACTIVE' })
  const olderActive = campaign({ id: 2, status: 'ACTIVE' })
  const upcoming = campaign({ id: 8, status: 'UPCOMING' })
  assert.equal(selectCampaign([newestEnded, active, olderActive]), active)
  assert.equal(selectCampaign([upcoming, newestEnded]), upcoming)
  assert.equal(selectCampaign([]), null)
})

test('the board is built from campaign fields and hardcodes only the draw odds', () => {
  for (const name of ['api.ts', 'view.ts', 'claim.ts', 'wallet.ts']) {
    const source = readFileSync(new URL(`../src/shield-and-win/${name}`, import.meta.url), 'utf8')
    for (const phrase of BANNED)
      assert.equal(source.includes(phrase), false, `${name} includes ${phrase}`)
    if (name !== 'view.ts') {
      assert.equal(source.includes(ODDS_LITERAL), false, `${name} includes ${ODDS_LITERAL}`)
    }
    assert.equal(/\bparseFloat\b|\btoFixed\b|\bNumber\(/.test(source), false, name)
  }
  assert.equal(shieldWinApiBase(), 'https://api.zknoir.com/v1/shield-win')

  const live = boardView(campaign(), 1_762_600_000 * 1000 - 3661 * 1000)
  assert.equal(live.state, 'live')
  assert.equal(live.pill, 'Live')
  assert.equal(
    boardView(campaign({ max_winners: 1 }), 1_762_600_000 * 1000 - 3661 * 1000).pill,
    'Live · Prize unclaimed'
  )
  assert.equal(live.canJoin, true)
  assert.equal(live.prizeAmount, '0.20')
  assert.equal(live.prizeAsset, 'ZEC')
  assert.equal(live.prizePoolLabel, '19.4 ZEC remaining in the prize pool')
  assert.equal(
    boardView(campaign({ max_winners: 0, winner_count: 4 }), 0).prizePoolLabel,
    'No cap on the prize pool'
  )
  assert.equal(
    boardView(campaign({ max_winners: 100, winner_count: 100 }), 0).prizePoolLabel,
    '0 ZEC remaining in the prize pool'
  )
  assert.equal(
    boardView(campaign({ max_winners: 3, winner_count: 9, reward_amount: '0.0001' }), 0)
      .prizePoolLabel,
    '0 ZEC remaining in the prize pool'
  )
  assert.equal(
    boardView(campaign({ max_winners: 50000, winner_count: 12, reward_amount: '0.0001' }), 0)
      .prizePoolLabel,
    '4.9988 ZEC remaining in the prize pool'
  )
  assert.equal(
    boardView(campaign({ reward_amount: 'nope', reward_asset: 'ZEC' }), 0).prizePoolLabel,
    ''
  )
  assert.equal(live.drawsSoFar, 57)
  assert.equal(live.endsLabel, 'Ends in')
  assert.equal(live.endsValue, '01:01:01')
  assert.equal(live.oddsLabel, 'Odds per draw')
  assert.equal(live.oddsValue, ODDS_LITERAL)
  assert.equal(live.minimumValue, '$25.50')
  assert.equal(live.winnerNote, 'Up to 100 winners · 3 so far')
  assert.equal(boardView(campaign({ min_usd_value: '$25.50' }), 0).minimumValue, '$25.50')
  assert.equal(
    boardView(campaign({ max_winners: 1, winner_count: 0 }), 0).winnerNote,
    'Only one winner'
  )
  assert.equal(
    boardView(campaign({ max_winners: 0, winner_count: 4 }), 0).winnerNote,
    'No winner cap'
  )
  assert.equal(deadlineLabel(1_762_600_000), 'Nov 8, 2025')
  assert.equal(deadlineLabel(Number.NaN), '')
  assert.equal(campaignStatusWord('UPCOMING'), 'Soon')
  assert.equal(campaignStatusWord('SOLD_OUT'), 'Ended')
  assert.equal(campaignStatusWord('ENDED'), 'Ended')
  assert.equal(boardView(campaign({ end_time: 100 }), 100 * 1000).endsValue, '00:00:00')
  assert.equal(boardView(campaign({ end_time: 100 }), 100 * 1000 + 5).endsValue, '00:00:00')

  const upcoming = boardView(campaign({ status: 'UPCOMING' }), 0)
  assert.equal(upcoming.state, 'upcoming')
  assert.equal(upcoming.pill, 'Not started')
  assert.equal(upcoming.canJoin, false)
  assert.equal(upcoming.endsLabel, 'Status')
  assert.equal(upcoming.endsValue, 'Soon')
  assert.equal(upcoming.oddsLabel, live.oddsLabel)
  assert.equal(upcoming.oddsValue, live.oddsValue)

  const soldOut = boardView(campaign({ status: 'SOLD_OUT', winner_count: 100 }), 0)
  assert.equal(soldOut.state, 'ended-won')
  assert.equal(soldOut.pill, 'Ended · Prize won')
  assert.equal(soldOut.endsLabel, 'Status')
  assert.equal(soldOut.endsValue, 'Ended')
  assert.equal(soldOut.canJoin, false)
  assert.equal(
    closedCampaignHint(soldOut),
    'The 0.20 ZEC prize has been won. Thank you for participating!'
  )

  const endedWon = boardView(campaign({ status: 'ENDED', winner_count: 2 }), 0)
  assert.equal(endedWon.state, 'ended-won')
  assert.equal(endedWon.pill, 'Ended · Prize won')
  assert.equal(endedWon.endsLabel, 'Status')
  assert.equal(endedWon.endsValue, 'Ended')
  assert.equal(endedWon.canJoin, false)
  assert.equal(
    closedCampaignHint(endedWon),
    'The 0.20 ZEC prize has been won. Thank you for participating!'
  )

  const endedNone = boardView(campaign({ status: 'ENDED', winner_count: 0, max_winners: 1 }), 0)
  assert.equal(endedNone.state, 'ended-none')
  assert.equal(endedNone.pill, 'Ended · No winner')
  assert.equal(endedNone.endsLabel, 'Status')
  assert.equal(endedNone.endsValue, 'Ended')
  assert.equal(endedNone.canJoin, false)
  assert.equal(
    closedCampaignHint(endedNone),
    'No one drew the winning number before the deadline. Thank you for participating!'
  )
  assert.equal(closedCampaignHint(upcoming), 'This campaign has not started.')
  assert.equal(closedCampaignHint(live), '')

  const missing = boardView(null, 0)
  assert.equal(missing.state, 'missing')
  assert.equal(missing.canJoin, false)
  assert.equal(missing.prizeAmount, '')
  assert.equal(missing.prizeAsset, '')
  assert.equal(missing.prizePoolLabel, '')
  assert.equal(missing.drawsSoFar, null)
  assert.equal(missing.endsLabel, 'Status')
  assert.equal(missing.endsValue, 'Unavailable')
  assert.equal(missing.oddsLabel, live.oddsLabel)
  assert.equal(missing.oddsValue, live.oddsValue)

  const rendered = JSON.stringify([live, upcoming, soldOut, endedWon, endedNone, missing])
  for (const phrase of BANNED) assert.equal(rendered.includes(phrase), false)
})

test('entry views describe the latest result without a draw number or confirmation count', () => {
  assert.equal(ENTRIES_LIST_POLL_INTERVAL_MS, 60_000)
  assert.equal(ENTRY_POLL_INTERVAL_MS, 4000)
  assert.equal(ENTRY_POLL_LIMIT, 12)
  assert.equal(REWARD_POLL_INTERVAL_MS, 4000)
  assert.equal(REWARD_POLL_LIMIT, 30)

  const rows = [entry({ id: 4, draw_result: 'NOT_WON' }), entry({ id: 9 }), entry({ id: 2 })]
  assert.equal(latestEntry(rows).id, 9)
  assert.deepEqual(
    sortedEntries([
      entry({ id: 9, shield_completed_at: 100 }),
      entry({ id: 3, shield_completed_at: 200 }),
      entry({ id: 7, shield_completed_at: 200 })
    ]).map(item => item.id),
    [7, 3, 9]
  )
  assert.equal(latestEntry([]), null)
  assert.equal(entryView(null), 'none')
  assert.equal(entryView(entry({ id: 77, draw_result: 'NOT_WON' })), 'notwon')
  assert.equal(entryView(entry({ reward_status: 'UNCLAIMED' })), 'won')
  assert.equal(entryView(entry({ reward_status: 'CLAIMING' })), 'claiming')
  assert.equal(entryView(entry({ reward_status: 'SENDING' })), 'sending')
  assert.equal(entryView(entry({ reward_status: 'COMPLETED' })), 'claimed')
  assert.equal(entryView(entry({ reward_status: 'FAILED' })), 'failed')
  const txHash = 'ab'.repeat(32)
  assert.equal(
    rewardTransactionUrl(entry({ reward_status: 'COMPLETED', transfer_hash: txHash })),
    `https://blockchair.com/zcash/transaction/${txHash}`
  )
  assert.equal(
    rewardTransactionUrl(entry({ reward_status: 'CLAIMING', transfer_hash: txHash })),
    null
  )
  assert.equal(rewardTransactionUrl(entry({ reward_status: 'COMPLETED' })), null)
  assert.equal(rewardTransactionUrl(entry({ draw_result: 'NOT_WON', transfer_hash: txHash })), null)

  const wins = unclaimedWins([
    entry({ id: 2 }),
    entry({ id: 5, draw_result: 'NOT_WON' }),
    entry({ id: 9, reward_status: 'CLAIMING' }),
    entry({ id: 7 })
  ])
  assert.deepEqual(
    wins.map(item => item.id),
    [7, 2]
  )

  const none = entryCopy('none', null)
  assert.equal(none.title, 'Not entered yet')
  assert.match(none.body, /have not entered yet/)

  const notwon = entryCopy('notwon', entry({ id: 77, operation_id: 4444, draw_result: 'NOT_WON' }))
  assert.equal(`${notwon.title} ${notwon.body}`.includes('77'), false)
  assert.equal(`${notwon.title} ${notwon.body}`.includes('4444'), false)
  assert.equal(notwon.title, 'No win')

  const won = entryCopy('won', entry())
  assert.equal(won.title, 'Unclaimed')
  assert.match(won.body, /Claim on this page to a Zcash transparent address/)

  for (const [view, status, title] of [
    ['claiming', 'CLAIMING', 'Claiming'],
    ['sending', 'SENDING', 'Sending']
  ]) {
    const copy = entryCopy(view, entry({ reward_status: status }))
    assert.equal(copy.title, title)
    assert.equal(copy.body.includes('of 10'), false)
    assert.equal(/confirmation/i.test(`${copy.title} ${copy.body}`), false)
    assert.equal(/\d/.test(`${copy.title} ${copy.body}`), false)
  }

  const completed = entryCopy('claimed', entry({ reward_status: 'COMPLETED' }))
  assert.equal(completed.title, 'Completed')
  assert.equal(completed.body, '')

  const failed = entryCopy('failed', entry({ reward_status: 'FAILED' }))
  assert.equal(failed.title, 'Failed')
  assert.match(failed.body, /contact support/i)
  assert.equal(
    /claim again|try claiming|claim once more/i.test(`${failed.title} ${failed.body}`),
    false
  )
})

test('claim text matches the signed bytes and only transparent addresses pass', () => {
  const message = claimMessage({
    entryId: 12,
    walletAddress: '0xAbC',
    zcashAddress: 't1MixedCASE'
  })
  assert.equal(
    message,
    'Shield & Win Claim\nEntry ID: 12\nWallet: 0xAbC\nZcash Address: t1MixedCASE'
  )
  assert.equal(message.endsWith('\n'), false)
  const hex = utf8ToHex(message)
  assert.match(hex, /^0x(?:[0-9a-f]{2})+$/)
  const bytes = Uint8Array.from(hex.slice(2).match(/../g), pair => Number.parseInt(pair, 16))
  assert.equal(new TextDecoder().decode(bytes), message)
  assert.equal(utf8ToHex('A'), '0x41')

  assert.equal(isTransparentZcashAddress(address('t1', 35)), true)
  assert.equal(isTransparentZcashAddress(address('tm', 35)), true)
  assert.equal(isTransparentZcashAddress(address('t3', 35)), true)
  assert.equal(isTransparentZcashAddress(address('t2', 35)), true)
  assert.equal(isTransparentZcashAddress(`  ${address('t1', 35)}  `), true)
  for (const value of [
    '',
    '   ',
    address('t1', 26),
    address('t1', 40),
    address('t1', 25),
    address('t1', 41),
    address('zs', 35),
    `u${'1'.repeat(34)}`,
    `tex1${'q'.repeat(20)}`,
    `${address('t1', 20)} ${'1'.repeat(14)}`,
    address('t1', 34) + '0',
    address('tm', 34) + 'O',
    address('t1', 34) + 'I',
    address('t1', 34) + 'l'
  ]) {
    assert.equal(isTransparentZcashAddress(value), false, value)
  }
})

test('a campaign without assets still loads and renders as ended when prizes were won', async () => {
  const campaigns = await getCampaigns(undefined, async () =>
    jsonResponse({
      code: 0,
      data: [
        {
          id: 1,
          name: 'Shield & Win Week 1',
          status: 'ENDED',
          start_time: 1795513569,
          end_time: 1795708799,
          min_usd_value: '0.5',
          max_winners: 50,
          reward_amount: '0.0001',
          reward_asset: 'ZEC',
          winner_count: 10,
          draw_count: 22
        }
      ]
    })
  )
  assert.equal(campaigns.length, 1)
  assert.deepEqual(campaigns[0].assets, [])
  assert.equal(campaigns[0].status, 'ENDED')
  assert.equal(campaigns[0].reward_amount, '0.0001')
  assert.equal(campaigns[0].winner_count, 10)

  const board = boardView(campaigns[0], Date.parse('2026-11-27T00:00:00Z'))
  assert.equal(board.state, 'ended-won')
  assert.equal(board.pill, 'Ended · Prize won')
  assert.equal(board.endsValue, 'Ended')
  assert.equal(board.canJoin, false)
  assert.equal(board.prizeAmount, '0.0001')
  assert.equal(board.prizeAsset, 'ZEC')
  assert.equal(
    closedCampaignHint(board),
    'The 0.0001 ZEC prize has been won. Thank you for participating!'
  )

  const withoutList = await getCampaigns(undefined, async () =>
    jsonResponse({ code: 0, data: [campaign({ assets: null })] })
  )
  assert.deepEqual(withoutList[0].assets, [])

  await assert.rejects(
    () =>
      getCampaigns(undefined, async () =>
        jsonResponse({ code: 0, data: [campaign({ assets: { asset_id: 'x', decimal: 6 } })] })
      ),
    /invalid response/
  )
})

test('code 0 returns decimal strings and HTTP 200 still follows the body code', async () => {
  const seen = []
  const campaigns = await getCampaigns(undefined, async (url, options) => {
    seen.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.cache, 'no-store')
    return jsonResponse({ code: 0, data: [campaign()] })
  })
  assert.deepEqual(seen, [`${shieldWinApiBase()}/campaigns`])
  assert.equal(campaigns[0].min_usd_value, '25.50')
  assert.equal(campaigns[0].reward_amount, '0.20')
  assert.equal(typeof campaigns[0].min_usd_value, 'string')
  assert.equal(typeof campaigns[0].reward_amount, 'string')

  const input = claimInput()
  const claimed = await claimReward(input, undefined, async (url, options) => {
    assert.equal(url, `${shieldWinApiBase()}/claim`)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), input)
    return jsonResponse({ code: 0, data: { entry_id: 12, reward_status: 'CLAIMING' } })
  })
  assert.deepEqual(claimed, { entry_id: 12, reward_status: 'CLAIMING' })

  const cases = [
    [-400, 'The request is not valid.'],
    [-401, 'The wallet is not authorized for this entry.'],
    [-500, 'Shield & Win is temporarily unavailable.'],
    [2004, 'This reward has already been claimed.'],
    [4004, 'This record does not exist.']
  ]
  for (const [code, message] of cases) {
    await assert.rejects(
      () =>
        claimReward(input, undefined, async () =>
          jsonResponse({ code, message: `server ${code}`, data: { entry_id: 12 } }, 200)
        ),
      error => {
        assert.ok(error instanceof ShieldWinApiError)
        assert.equal(typeof error.code, 'number')
        assert.equal(error.code, code)
        assert.equal(error.message, message)
        assert.equal(error.detail, `server ${code}`)
        return true
      }
    )
  }
  await assert.rejects(
    () =>
      claimReward(input, undefined, async () => jsonResponse({ code: 999, message: 'nope' }, 200)),
    error => {
      assert.ok(error instanceof ShieldWinApiError)
      assert.equal(error.code, 999)
      assert.equal(error.message, 'Shield & Win could not complete this request.')
      return true
    }
  )
})

test('entries are queried by wallet address and malformed payloads are rejected', async () => {
  const page = await getEntries(
    {
      wallet_address: '0xAbC',
      campaign_id: 3,
      draw_result: 'WON',
      page_size: 20,
      page_number: 1,
      operation_id: 99
    },
    undefined,
    async (url, options) => {
      const parsed = new URL(url)
      assert.equal(parsed.origin + parsed.pathname, `${shieldWinApiBase()}/entries`)
      assert.equal(parsed.searchParams.has('operation_id'), false)
      assert.equal(parsed.searchParams.get('wallet_address'), '0xAbC')
      assert.equal(parsed.searchParams.get('campaign_id'), '3')
      assert.equal(parsed.searchParams.get('draw_result'), 'WON')
      assert.equal(options.method, 'GET')
      return jsonResponse({
        code: 0,
        data: { list: [], total: 0, page_size: 20, page_number: 1, has_next_page: false }
      })
    }
  )
  assert.deepEqual(page.list, [])

  const won = await getEntries({ wallet_address: '0xAbC' }, undefined, async () =>
    jsonResponse({
      code: 0,
      data: {
        list: [
          entry({ reward_status: 'COMPLETED', transfer_hash: `0x${'ab'.repeat(32)}` }),
          {
            ...entry({ id: 4, draw_result: 'NOT_WON' }),
            reward_amount: undefined,
            reward_asset: undefined,
            reward_status: undefined,
            transfer_hash: ''
          }
        ],
        total: 2,
        page_size: 20,
        page_number: 1,
        has_next_page: false
      }
    })
  )
  assert.equal(won.list[0].usd_value, '25.50')
  assert.equal('credited_amount' in won.list[0], false)
  assert.equal(typeof won.list[0].usd_value, 'string')
  assert.equal(won.list[0].operation_id, 98765)
  assert.equal(won.list[0].transfer_hash, 'ab'.repeat(32))
  assert.equal(won.list[1].reward_status, undefined)
  assert.equal(won.list[1].transfer_hash, undefined)

  const invalidHash = await getEntries({}, undefined, async () =>
    jsonResponse({
      code: 0,
      data: {
        list: [entry({ reward_status: 'COMPLETED', transfer_hash: 'javascript:alert(1)' })],
        total: 1,
        page_size: 20,
        page_number: 1,
        has_next_page: false
      }
    })
  )
  assert.equal(invalidHash.list[0].transfer_hash, undefined)

  const failures = [
    async () => new Response('not-json', { status: 200 }),
    async () => jsonResponse({ code: 0, data: [{ id: 1 }] }),
    async () => jsonResponse({ code: 0, data: [campaign({ min_usd_value: 25.5 })] }),
    async () => jsonResponse({ code: 0, data: [campaign({ reward_amount: 0.2 })] }),
    async () => jsonResponse({ code: '0', data: [] }),
    async () => jsonResponse({}),
    async () => jsonResponse({ code: 0, data: { list: [entry({ usd_value: 25.5 })] } }),
    async () => jsonResponse({ code: 0, data: { list: [entry({ reward_status: undefined })] } })
  ]
  for (const fetcher of failures) {
    await assert.rejects(
      () => getCampaigns(undefined, fetcher),
      error => {
        assert.equal(error instanceof ShieldWinApiError, false)
        return true
      }
    )
  }
  await assert.rejects(
    () => getEntries({ wallet_address: '0xAbC' }, undefined, failures[6]),
    error => {
      assert.equal(error instanceof ShieldWinApiError, false)
      assert.match(error.message, /invalid response|unreadable response/)
      return true
    }
  )
  await assert.rejects(
    () =>
      getCampaigns(undefined, async () => {
        throw new TypeError('Failed to fetch')
      }),
    { message: 'Shield & Win could not be reached.' }
  )
})

test('the token catalog resolves network and symbol by exact asset ID with a safe fallback', async () => {
  const labels = await getAssetLabels(undefined, async (url, options) => {
    assert.equal(url, 'https://1click.chaindefuser.com/v0/tokens')
    assert.equal(options.method, undefined)
    return jsonResponse([
      { assetId: 'nep141:usdt.tether-token.near', blockchain: 'near', symbol: 'USDT' },
      {
        assetId: 'nep141:eth.omft.near',
        blockchain: 'eth',
        symbol: 'ETH',
        icon: 'https://assets.example/eth.png',
        coingeckoIcon: 'https://coin-images.coingecko.com/coins/images/279/large/ethereum.png'
      },
      {
        assetId: 'nep141:base-usdc.omft.near',
        blockchain: 'base',
        symbol: 'USDC',
        icon: 'http://evil.example/usdc.png',
        coingeckoIcon: 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png'
      },
      { assetId: 'bad', blockchain: 'near' }
    ])
  })
  assert.deepEqual(labels.get('nep141:usdt.tether-token.near'), {
    symbol: 'USDT',
    network: 'NEAR',
    tokenIconUrl: null,
    chainIconUrl: 'https://assets.zknoir.com/chain/near.svg'
  })
  assert.equal(assetLabel('nep141:usdt.tether-token.near', labels), 'NEAR · USDT')
  assert.deepEqual(labels.get('nep141:eth.omft.near'), {
    symbol: 'ETH',
    network: 'Ethereum',
    tokenIconUrl: 'https://assets.example/eth.png',
    chainIconUrl: 'https://assets.zknoir.com/chain/ethereum.svg'
  })
  assert.equal(
    labels.get('nep141:base-usdc.omft.near')?.tokenIconUrl,
    'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png'
  )
  assert.equal(
    labels.get('nep141:base-usdc.omft.near')?.chainIconUrl,
    'https://assets.zknoir.com/chain/base.svg'
  )
  assert.equal(assetLabel('nep141:unknown.near', labels), 'nep141:unknown.near')
  assert.equal(assetInfo('nep141:unknown.near', labels).tokenIconUrl, null)
  assert.equal(labels.has('bad'), false)
  await assert.rejects(
    () => getAssetLabels(undefined, async () => jsonResponse({ list: [] })),
    /invalid/
  )
})

test('missing catalog icons are filled from the Rhea chain list', async () => {
  const assetId = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
  const calls = []
  const labels = await getAssetLabels(
    undefined,
    async url => {
      calls.push(url)
      if (url === 'https://1click.chaindefuser.com/v0/tokens') {
        return jsonResponse([
          { assetId, blockchain: 'base', symbol: 'USDC', icon: null, coingeckoIcon: null },
          {
            assetId: 'nep141:eth.omft.near',
            blockchain: 'eth',
            symbol: 'ETH',
            icon: 'https://assets.example/eth.png'
          }
        ])
      }
      return jsonResponse([
        { assetId, icon: 'http://evil.example/usdc.png' },
        {
          assetId,
          icon: 'https://ref-new-1.s3.amazonaws.com/token/76c6fe8560fc7f0dc487edfe08cc5fbc.png'
        }
      ])
    },
    [assetId, 'nep141:eth.omft.near']
  )
  assert.deepEqual(calls, [
    'https://1click.chaindefuser.com/v0/tokens',
    'https://api.rhea.finance/get_multichain_lending_tokens_data?chains=base'
  ])
  assert.equal(
    labels.get(assetId)?.tokenIconUrl,
    'https://ref-new-1.s3.amazonaws.com/token/76c6fe8560fc7f0dc487edfe08cc5fbc.png'
  )
  assert.equal(labels.get('nep141:eth.omft.near')?.tokenIconUrl, 'https://assets.example/eth.png')

  const kept = await getAssetLabels(
    undefined,
    async url => {
      if (url.startsWith('https://api.rhea.finance/')) throw new Error('offline')
      return jsonResponse([
        { assetId: 'nep141:base-usdc.omft.near', blockchain: 'base', symbol: 'USDC' }
      ])
    },
    ['nep141:base-usdc.omft.near']
  )
  assert.equal(kept.get('nep141:base-usdc.omft.near')?.tokenIconUrl, null)
  assert.equal(kept.get('nep141:base-usdc.omft.near')?.network, 'Base')
})

test('entry USD values show two decimals and mark sub-cent amounts', () => {
  assert.equal(formatEntryUsd('0.94725794'), '$0.95')
  assert.equal(formatEntryUsd('0.62118355'), '$0.62')
  assert.equal(formatEntryUsd('0.75205424'), '$0.75')
  assert.equal(formatEntryUsd('0.54194357'), '$0.54')
  assert.equal(formatEntryUsd('0.75485608'), '$0.75')
  assert.equal(formatEntryUsd('1.54920033'), '$1.55')
  assert.equal(formatEntryUsd('0'), '$0.00')
  assert.equal(formatEntryUsd('0.00'), '$0.00')
  assert.equal(formatEntryUsd('0.009'), '< $0.01')
  assert.equal(formatEntryUsd('0.005'), '< $0.01')
  assert.equal(formatEntryUsd('0.01'), '$0.01')
  assert.equal(formatEntryUsd('0.5'), '$0.50')
  assert.equal(formatEntryUsd('25.50'), '$25.50')
  assert.equal(formatEntryUsd('9.995'), '$10.00')
  assert.equal(formatEntryUsd('1.005'), '$1.01')
  assert.equal(formatEntryUsd('not-a-number'), '$not-a-number')
  assert.equal(formatEntryUsd('$1.2'), '$1.2')
})

test('missing Rhea icons are filled from CoinGecko by coingecko id', async () => {
  const bnb = 'nep141:bnb.omdep.near'
  const pol = 'nep141:pol.omdep.near'
  const bad = 'nep141:bad.near'
  const custom = 'nep141:custom.near'
  const kept = 'nep141:eth.omft.near'
  const calls = []
  const labels = await getAssetLabels(
    undefined,
    async url => {
      calls.push(url)
      if (url === 'https://1click.chaindefuser.com/v0/tokens') {
        return jsonResponse([
          { assetId: bnb, blockchain: 'bsc', symbol: 'BNB', coingeckoId: 'binancecoin' },
          {
            assetId: pol,
            blockchain: 'pol',
            symbol: 'POL',
            coingeckoId: 'polygon-ecosystem-token'
          },
          { assetId: bad, blockchain: 'near', symbol: 'BAD', coingeckoId: 'not-a-coin' },
          { assetId: custom, blockchain: 'near', symbol: 'CST', coingeckoId: 'custom:cst' },
          {
            assetId: kept,
            blockchain: 'eth',
            symbol: 'ETH',
            icon: 'https://assets.example/eth.png',
            coingeckoId: 'ethereum'
          }
        ])
      }
      if (url.startsWith('https://api.rhea.finance/')) return jsonResponse([])
      return jsonResponse([
        {
          id: 'binancecoin',
          image:
            'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png?1696501970'
        },
        { id: 'polygon-ecosystem-token', image: 'http://evil.example/pol.png' },
        {
          id: 'polygon-ecosystem-token',
          image: 'https://coin-images.coingecko.com/coins/images/32440/large/pol.png?1759114181'
        },
        { id: 'not-a-coin', image: 'https://example.com/not-coingecko.png' }
      ])
    },
    [bnb, pol, bad, custom, kept]
  )
  assert.equal(
    labels.get(bnb)?.tokenIconUrl,
    'https://coin-images.coingecko.com/coins/images/825/large/bnb-icon2_2x.png?1696501970'
  )
  assert.equal(
    labels.get(pol)?.tokenIconUrl,
    'https://coin-images.coingecko.com/coins/images/32440/large/pol.png?1759114181'
  )
  assert.equal(labels.get(bad)?.tokenIconUrl, null)
  assert.equal(labels.get(custom)?.tokenIconUrl, null)
  assert.equal(labels.get(kept)?.tokenIconUrl, 'https://assets.example/eth.png')
  const gecko = calls.find(url => url.startsWith('https://api.coingecko.com/'))
  assert.equal(typeof gecko, 'string')
  const query = new URL(gecko).searchParams
  assert.equal(query.get('vs_currency'), 'usd')
  assert.equal(query.get('sparkline'), 'false')
  assert.equal(query.get('ids'), 'binancecoin,polygon-ecosystem-token,not-a-coin')

  const failed = await getAssetLabels(
    undefined,
    async url => {
      if (url.startsWith('https://api.coingecko.com/')) throw new Error('offline')
      if (url.startsWith('https://api.rhea.finance/')) return jsonResponse([])
      return jsonResponse([
        { assetId: bnb, blockchain: 'bsc', symbol: 'BNB', coingeckoId: 'binancecoin' }
      ])
    },
    [bnb]
  )
  assert.equal(failed.get(bnb)?.tokenIconUrl, null)
  assert.equal(failed.get(bnb)?.symbol, 'BNB')
  assert.equal(failed.get(bnb)?.network, 'BNB Chain')
})

test('all entries loads every page and rejects a stalled pagination response', async () => {
  const pages = []
  const list = await getAllEntries(
    { wallet_address: '0xAbC', campaign_id: 1 },
    undefined,
    async url => {
      const query = new URL(url).searchParams
      const page = Number(query.get('page_number'))
      pages.push(page)
      assert.equal(query.get('page_size'), '100')
      return jsonResponse({
        code: 0,
        data: {
          list: [entry({ id: page })],
          total: 2,
          page_size: 100,
          page_number: page,
          has_next_page: page === 1
        }
      })
    }
  )
  assert.deepEqual(pages, [1, 2])
  assert.deepEqual(
    list.map(item => item.id),
    [1, 2]
  )
  await assert.rejects(
    () =>
      getAllEntries({}, undefined, async () =>
        jsonResponse({
          code: 0,
          data: { list: [], total: 2, page_size: 100, page_number: 1, has_next_page: true }
        })
      ),
    /invalid response/
  )
})

test('cancellation stays an AbortError', async () => {
  const controller = new AbortController()
  const pending = getCampaigns(
    controller.signal,
    async (_url, options) =>
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          {
            once: true
          }
        )
      })
  )
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('readConnectedTransparentAddress stays silent', async () => {
  const transparent = address('t1', 35)
  const calls = []
  const payout = await readConnectedTransparentAddress({
    async request(args) {
      calls.push(args.method)
      if (args.method === 'zcash_getAccounts')
        return { transparent, shielded: `zs${'1'.repeat(40)}` }
      throw new Error(`unexpected ${args.method}`)
    }
  })
  assert.equal(payout, transparent)
  assert.deepEqual(calls, ['zcash_getAccounts'])

  const missing = []
  assert.equal(
    await readConnectedTransparentAddress({
      async request(args) {
        missing.push(args.method)
        return null
      }
    }),
    null
  )
  assert.equal(
    await readConnectedTransparentAddress({
      async request(args) {
        missing.push(args.method)
        return { transparent: `zs${'1'.repeat(40)}` }
      }
    }),
    null
  )
  assert.deepEqual(missing, ['zcash_getAccounts', 'zcash_getAccounts'])
})

test('connectTransparentAddress asks once and rejects an unusable address', async () => {
  const transparent = `  ${address('tm', 35)}  `
  const calls = []
  const payout = await connectTransparentAddress({
    async request(args) {
      calls.push(args.method)
      if (args.method === 'zcash_requestAccounts') return { transparent }
      throw new Error(`unexpected ${args.method}`)
    }
  })
  assert.equal(payout, transparent.trim())
  assert.deepEqual(calls, ['zcash_requestAccounts'])

  await assert.rejects(
    () =>
      connectTransparentAddress({
        async request() {
          return { transparent: 'not-an-address' }
        }
      }),
    /transparent address/
  )
  const unsupported = new Error('No authorized Zcash account available')
  assert.equal(isUnsupportedZcashAccount(unsupported), true)
  assert.equal(
    isUnsupportedZcashAccount(new Error('Noir Wallet did not return a transparent address.')),
    true
  )
  assert.equal(
    isUnsupportedZcashAccount(Object.assign(new Error('rejected'), { code: 4001 })),
    false
  )
})

test('disconnectZcash revokes only the Zcash provider session', async () => {
  const calls = []
  await disconnectZcash({
    async request(args) {
      calls.push(args)
      return null
    }
  })
  assert.deepEqual(calls, [{ method: 'zcash_disconnect', params: [] }])
})

test('detectZcashProvider reads the Zcash provider separately from the EVM provider', () => {
  const ethereum = { request: async () => [] }
  const zcash = { request: async () => null }
  const previous = globalThis.noirwallet
  globalThis.noirwallet = { isNoirWallet: true, ethereum, zcash }
  try {
    assert.equal(detectNoirWallet(), ethereum)
    assert.equal(detectZcashProvider(), zcash)
    globalThis.noirwallet = { isNoirWallet: true, ethereum }
    assert.equal(detectZcashProvider(), null)
  } finally {
    if (previous === undefined) delete globalThis.noirwallet
    else globalThis.noirwallet = previous
  }
})

test('revokeAccount drops only the eth_accounts permission', async () => {
  const calls = []
  await revokeAccount({
    async request(args) {
      calls.push(args)
      return null
    }
  })
  assert.deepEqual(calls, [{ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }])
})

test('the campaign page reserves a skeleton and keeps rules on the interface', () => {
  const page = readFileSync(new URL('../src/pages/ShieldAndWinPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /h-\[clamp\(44px,5vw,72px\)\]/)
  assert.match(page, /h-\[calc\(clamp\(15px,1\.2vw,18px\)\*1\.55\)\]/)
  assert.match(page, /Connect to see your entry and result on this page\./)
  const installAction = page.slice(page.indexOf('const showInstall'), page.indexOf('const showTry'))
  const tryAction = page.slice(page.indexOf('const showTry'), page.indexOf('const showConnect'))
  const connectAction = page.slice(
    page.indexOf('const showConnect'),
    page.indexOf('const showExplore')
  )
  assert.match(installAction, /walletLinkOpen/)
  assert.equal(installAction.includes('canJoin'), false)
  assert.match(tryAction, /campaignOpen/)
  assert.match(tryAction, /board\.canJoin/)
  assert.match(connectAction, /walletLinkOpen/)
  assert.equal(connectAction.includes('canJoin'), false)
  assert.match(page, /Open Noir Wallet from the Chrome toolbar\./)
  assert.equal(page.includes('must land after fees'), false)
  assert.match(page, /Draws so far/)
  assert.equal(page.includes('sk-title'), false)
  assert.match(page, /aria-label="Disconnect"/)
  assert.match(page, /aria-label="Refresh your entries"/)
  assert.equal(page.includes('credited_amount'), false)
  const entryRow = page.slice(
    page.indexOf('function EntryRow('),
    page.indexOf('function SupportLink()')
  )
  assert.equal(entryRow.includes('<RefreshIcon'), false)
  assert.equal(entryRow.includes('<span>USD value</span>'), false)
  assert.equal(entryRow.includes('<span>Completed</span>'), false)
  assert.match(
    page,
    /function EntryColumns\([\s\S]*<span>Asset<\/span>[\s\S]*<span>USD value<\/span>[\s\S]*<span>Completed<\/span>/
  )
  assert.match(entryRow, /view === 'notwon' \? 'Draw result' : 'Reward status'/)
  assert.match(entryRow, /const transactionUrl = rewardTransactionUrl\(entry\)/)
  assert.match(
    entryRow,
    /className="inline-flex w-11[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"/
  )
  assert.equal((page.match(/<EntriesRefreshButton/g) ?? []).length, 2)
  assert.match(page, /const ENTRY_REFRESH_COOLDOWN_MS = 60_000/)
  assert.match(page, /setInterval\(refreshEntries, ENTRIES_LIST_POLL_INTERVAL_MS\)/)
  const participate = page.slice(page.indexOf('function onParticipate()'))
  const participateBody = participate.slice(0, participate.indexOf('\n  }'))
  assert.equal(participateBody.includes('startEntryPoll'), false)
  assert.match(page, /NEAR Confidential/)
  assert.match(page, /zknoir\.com reserves the right to interpret this campaign\./)
  assert.equal(page.includes('Loading the campaign.'), false)
  assert.match(page, /Each transfer can only be drawn once\./)
  assert.match(page, /1 in 444/)
  assert.match(page, /~0\.225%/)
  assert.equal(page.includes('Winners receive the full {prize}'), true)
  assert.equal(page.includes('4,444'), false)
  assert.equal(page.includes('{prize} ZEC'), false)
  assert.equal(page.includes('Every draw is independent'), false)
  assert.equal(page.includes('Fees may apply.'), false)
  assert.match(page, /board\.prizePoolLabel/)
  const participateClick = page.indexOf('onClick={onParticipate}')
  const tryClass = page.slice(participateClick - 1800, participateClick)
  assert.equal(tryClass.includes('cursor-pointer'), false)
  assert.match(tryClass, /cursor-default/)
  assert.equal(page.includes('nep141:'), false)
  assert.equal(page.includes('$10'), false)
  assert.equal(page.includes('1 ZEC'), false)
  assert.match(page, /aria-label="Transparent address"/)
  assert.match(page, /readConnectedTransparentAddress/)
  assert.match(page, /connectTransparentAddress/)
  assert.match(page, /disconnectZcash/)
  assert.match(page, /Zcash · Transparent/)
  assert.match(page, /Not connected/)
  assert.match(page, /Connect Noir Wallet/)
  assert.match(page, /Enter address/)
  assert.match(page, /Claim \$\{rewardText\(claimTarget\)\}/)
  assert.match(page, /aria-label="Disconnect Zcash"/)
  assert.match(page, /w-\[min\(360px,calc\(100%-32px\)\)\]/)
  assert.match(page, /open:flex/)
  assert.match(page, /overflow-auto/)
  assert.match(page, /overflow-hidden/)
})

test('the portal tooltip does not inherit the home page tip positioning', () => {
  const component = readFileSync(new URL('../src/components/Tooltip.tsx', import.meta.url), 'utf8')
  const homeCss = readFileSync(new URL('../src/home/site.css', import.meta.url), 'utf8')
  assert.match(homeCss, /^\.tip \{/m)
  assert.match(component, /useLayoutEffect/)
  assert.match(component, /fixed z-\[80\]/)
  assert.match(component, /data-\[side=top\]:-translate-y-\[calc\(100%\+10px\)\]/)
  assert.equal(component.includes('tooltip.css'), false)
  assert.equal(component.includes('.tip'), false)
})

test('wallet helpers use the existing EVM provider and keep rejection text', async () => {
  const calls = []
  const provider = {
    async request(args) {
      calls.push(args)
      if (args.method === 'eth_accounts') return ['0xAbC']
      if (args.method === 'eth_requestAccounts') return ['0xAbC']
      if (args.method === 'personal_sign') return `0x${'aa'.repeat(65)}`
      throw new Error(`unexpected ${args.method}`)
    },
    on(event, listener) {
      this.listener = listener
      this.event = event
    },
    removeListener(event, listener) {
      this.removed = { event, listener }
    }
  }
  const previous = globalThis.noirwallet
  globalThis.noirwallet = { isNoirWallet: true, ethereum: provider }
  try {
    assert.equal(detectNoirWallet(), provider)
    assert.deepEqual(calls, [])
    assert.equal(await readAccounts(provider), '0xAbC')
    assert.equal(await requestAccount(provider), '0xAbC')
    const message = claimMessage({
      entryId: 12,
      walletAddress: '0xAbC',
      zcashAddress: address('t1', 35)
    })
    assert.equal(await signClaim(provider, '0xAbC', message), `0x${'aa'.repeat(65)}`)
    assert.deepEqual(calls[2], { method: 'personal_sign', params: [utf8ToHex(message), '0xAbC'] })
    for (const method of [
      'wallet_openCampaign',
      'wallet_getCampaignStatus',
      'shield_transfer',
      'zcash_getAddresses'
    ]) {
      assert.equal(
        calls.some(args => args.method === method),
        false
      )
    }
  } finally {
    if (previous === undefined) delete globalThis.noirwallet
    else globalThis.noirwallet = previous
  }

  assert.equal(await readAccounts({ request: async () => [] }), null)
  await assert.rejects(() => requestAccount({ request: async () => [] }))

  const seen = []
  const unsubscribe = subscribeAccounts(provider, account => seen.push(account))
  provider.listener(['0xAbC'])
  provider.listener([])
  unsubscribe()
  unsubscribe()
  assert.equal(provider.event, 'accountsChanged')
  assert.deepEqual(seen, ['0xAbC', null])
  assert.equal(provider.removed.listener, provider.listener)
  let listened = false
  subscribeAccounts(
    {
      request: async () => [],
      on() {
        listened = true
      }
    },
    () => {}
  )()
  assert.equal(listened, false)

  const keystone = 'Keystone EVM signing is available only from the Noir Wallet transaction screen.'
  assert.equal(walletErrorMessage({ code: 4200, message: keystone }), keystone)
  assert.equal(
    walletErrorMessage({ code: 4001, message: 'User rejected the request.' }),
    'The request was rejected in Noir Wallet.'
  )
  const signature = `0x${'ab'.repeat(65)}`
  assert.equal(walletErrorMessage({ message: signature }).includes(signature), false)
  const seed =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  assert.equal(walletErrorMessage(new Error(seed)).includes('abandon'), false)
})

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem(key) {
      return items.has(key) ? items.get(key) : null
    },
    setItem(key, value) {
      items.set(key, String(value))
    },
    removeItem(key) {
      items.delete(key)
    }
  }
}

test('campaign cache restores a validated campaign and ignores bad storage', () => {
  const storage = memoryStorage()
  assert.equal(readCachedCampaign(storage), null)
  writeCachedCampaign(campaign(), storage)
  assert.deepEqual(readCachedCampaign(storage), campaign())
  clearCachedCampaign(storage)
  assert.equal(readCachedCampaign(storage), null)

  const corrupt = memoryStorage({ 'shield-win.campaign.v1': '{' })
  assert.equal(readCachedCampaign(corrupt), null)
  const invalid = memoryStorage({ 'shield-win.campaign.v1': JSON.stringify({ status: 'ACTIVE' }) })
  assert.equal(readCachedCampaign(invalid), null)

  const denied = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    },
    removeItem() {
      throw new Error('denied')
    }
  }
  assert.equal(readCachedCampaign(denied), null)
  assert.doesNotThrow(() => writeCachedCampaign(campaign(), denied))
  assert.doesNotThrow(() => clearCachedCampaign(denied))
  assert.equal(readCachedCampaign(null), null)
  assert.doesNotThrow(() => writeCachedCampaign(campaign(), null))
  assert.doesNotThrow(() => clearCachedCampaign(null))
})
