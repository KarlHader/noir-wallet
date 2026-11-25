import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  ShieldWinApiError,
  claimReward,
  getCampaigns,
  getEntries,
  selectCampaign,
  shieldWinApiBase
} from '../src/shield-and-win/api.ts'
import { claimMessage, isTransparentZcashAddress, utf8ToHex } from '../src/shield-and-win/claim.ts'
import {
  ENTRY_POLL_INTERVAL_MS,
  ENTRY_POLL_LIMIT,
  REWARD_POLL_INTERVAL_MS,
  REWARD_POLL_LIMIT,
  boardView,
  campaignStatusWord,
  deadlineLabel,
  entryCopy,
  entryView,
  latestEntry,
  unclaimedWins
} from '../src/shield-and-win/view.ts'
import {
  detectNoirWallet,
  readAccounts,
  requestAccount,
  revokeAccount,
  signClaim,
  subscribeAccounts,
  walletErrorMessage
} from '../src/shield-and-win/wallet.ts'

const BANNED = ['1 / 4444', '$10', '1 ZEC', 'shielded']

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

test('the board is built from campaign fields and does not hardcode prototype facts', () => {
  for (const name of ['api.ts', 'view.ts', 'claim.ts', 'wallet.ts']) {
    const source = readFileSync(new URL(`../src/shield-and-win/${name}`, import.meta.url), 'utf8')
    for (const phrase of BANNED) assert.equal(source.includes(phrase), false, `${name} includes ${phrase}`)
    assert.equal(/\bparseFloat\b|\btoFixed\b|\bNumber\(/.test(source), false, name)
  }
  assert.equal(shieldWinApiBase(), 'https://api.zknoir.com/v1/shield-win')

  const live = boardView(campaign(), 1_762_600_000 * 1000 - 3661 * 1000)
  assert.equal(live.state, 'live')
  assert.equal(live.pill, 'Live · Prize unclaimed')
  assert.equal(live.canJoin, true)
  assert.equal(live.prizeAmount, '0.20')
  assert.equal(live.prizeAsset, 'ZEC')
  assert.equal(live.prizeDestination, 'Sent to a Zcash transparent address you confirm')
  assert.equal(live.drawsSoFar, 57)
  assert.equal(live.endsLabel, 'Ends in')
  assert.equal(live.endsValue, '01:01:01')
  assert.equal(live.minimumLabel, 'Minimum credited')
  assert.equal(live.minimumValue, '$25.50')
  assert.equal(live.winnerNote, 'Up to 100 winners · 3 so far')
  assert.equal(boardView(campaign({ min_usd_value: '$25.50' }), 0).minimumValue, '$25.50')
  assert.equal(boardView(campaign({ max_winners: 1, winner_count: 0 }), 0).winnerNote, 'Only one winner')
  assert.equal(boardView(campaign({ max_winners: 0, winner_count: 4 }), 0).winnerNote, 'No winner cap')
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

  const soldOut = boardView(campaign({ status: 'SOLD_OUT', winner_count: 100 }), 0)
  assert.equal(soldOut.state, 'sold-out')
  assert.equal(soldOut.pill, 'Ended · Prizes sent')
  assert.equal(soldOut.endsValue, 'Ended')
  assert.equal(soldOut.canJoin, false)

  const endedWon = boardView(campaign({ status: 'ENDED', winner_count: 2 }), 0)
  assert.equal(endedWon.state, 'ended-won')
  assert.equal(endedWon.pill, 'Ended · Prize won')
  assert.equal(endedWon.endsValue, 'Ended')
  assert.equal(endedWon.canJoin, false)

  const endedNone = boardView(campaign({ status: 'ENDED', winner_count: 0, max_winners: 1 }), 0)
  assert.equal(endedNone.state, 'ended-none')
  assert.equal(endedNone.pill, 'Ended · No winner')
  assert.equal(endedNone.canJoin, false)

  const missing = boardView(null, 0)
  assert.equal(missing.state, 'missing')
  assert.equal(missing.canJoin, false)
  assert.equal(missing.prizeAmount, '')
  assert.equal(missing.prizeAsset, '')
  assert.equal(missing.prizeDestination, '')
  assert.equal(missing.drawsSoFar, null)
  assert.equal(missing.endsLabel, 'Status')
  assert.equal(missing.endsValue, 'Unavailable')

  const rendered = JSON.stringify([live, upcoming, soldOut, endedWon, endedNone, missing])
  for (const phrase of BANNED) assert.equal(rendered.includes(phrase), false)
})

test('entry views describe the latest result without a draw number or confirmation count', () => {
  assert.equal(ENTRY_POLL_INTERVAL_MS, 4000)
  assert.equal(ENTRY_POLL_LIMIT, 12)
  assert.equal(REWARD_POLL_INTERVAL_MS, 4000)
  assert.equal(REWARD_POLL_LIMIT, 30)

  const rows = [entry({ id: 4, draw_result: 'NOT_WON' }), entry({ id: 9 }), entry({ id: 2 })]
  assert.equal(latestEntry(rows).id, 9)
  assert.equal(latestEntry([]), null)
  assert.equal(entryView(null), 'none')
  assert.equal(entryView(entry({ id: 77, draw_result: 'NOT_WON' })), 'notwon')
  assert.equal(entryView(entry({ reward_status: 'UNCLAIMED' })), 'won')
  assert.equal(entryView(entry({ reward_status: 'CLAIMING' })), 'claiming')
  assert.equal(entryView(entry({ reward_status: 'SENDING' })), 'sending')
  assert.equal(entryView(entry({ reward_status: 'COMPLETED' })), 'claimed')
  assert.equal(entryView(entry({ reward_status: 'FAILED' })), 'failed')

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
  assert.match(notwon.title, /Not a winner/)

  const won = entryCopy('won', entry())
  assert.match(won.body, /Claim on this page to a Zcash transparent address/)

  for (const view of ['claiming', 'sending']) {
    const copy = entryCopy(view, entry({ reward_status: view === 'claiming' ? 'CLAIMING' : 'SENDING' }))
    assert.equal(copy.body.includes('of 10'), false)
    assert.equal(/confirmation/i.test(`${copy.title} ${copy.body}`), false)
    assert.equal(/\d/.test(`${copy.title} ${copy.body}`), false)
  }

  const failed = entryCopy('failed', entry({ reward_status: 'FAILED' }))
  assert.match(`${failed.title} ${failed.body}`, /needs support/i)
  assert.equal(/claim again|try claiming|claim once more/i.test(`${failed.title} ${failed.body}`), false)
})

test('claim text matches the signed bytes and only transparent addresses pass', () => {
  const message = claimMessage({
    entryId: 12,
    walletAddress: '0xAbC',
    zcashAddress: 't1MixedCASE'
  })
  assert.equal(message, 'Shield & Win Claim\nEntry ID: 12\nWallet: 0xAbC\nZcash Address: t1MixedCASE')
  assert.equal(message.endsWith('\n'), false)
  const hex = utf8ToHex(message)
  assert.match(hex, /^0x(?:[0-9a-f]{2})+$/)
  const bytes = Uint8Array.from(hex.slice(2).match(/../g), pair => Number.parseInt(pair, 16))
  assert.equal(new TextDecoder().decode(bytes), message)
  assert.equal(utf8ToHex('A'), '0x41')

  assert.equal(isTransparentZcashAddress(address('t1', 35)), true)
  assert.equal(isTransparentZcashAddress(address('tm', 35)), true)
  assert.equal(isTransparentZcashAddress(`  ${address('t1', 26)}  `), true)
  assert.equal(isTransparentZcashAddress(address('t1', 40)), true)
  for (const value of [
    '',
    '   ',
    address('t1', 25),
    address('t1', 41),
    address('t3', 35),
    address('t2', 35),
    address('zs', 35),
    `u${'1'.repeat(34)}`,
    `${address('t1', 20)} ${'1'.repeat(14)}`,
    address('t1', 34) + '0',
    address('tm', 34) + 'O',
    address('t1', 34) + 'I',
    address('t1', 34) + 'l'
  ]) {
    assert.equal(isTransparentZcashAddress(value), false, value)
  }
})

test('code 0 returns decimal strings and HTTP 200 still follows the body code', async () => {
  const seen = []
  const campaigns = await getCampaigns(undefined, async (url, options) => {
    seen.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.cache, 'no-store')
    return jsonResponse({ code: 0, data: [campaign()] })
  })
  assert.deepEqual(seen, ['https://api.zknoir.com/v1/shield-win/campaigns'])
  assert.equal(campaigns[0].min_usd_value, '25.50')
  assert.equal(campaigns[0].reward_amount, '0.20')
  assert.equal(typeof campaigns[0].min_usd_value, 'string')
  assert.equal(typeof campaigns[0].reward_amount, 'string')

  const input = claimInput()
  const claimed = await claimReward(input, undefined, async (url, options) => {
    assert.equal(url, 'https://api.zknoir.com/v1/shield-win/claim')
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
    () => claimReward(input, undefined, async () => jsonResponse({ code: 999, message: 'nope' }, 200)),
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
    { wallet_address: '0xAbC', campaign_id: 3, draw_result: 'WON', page_size: 20, page_number: 1, operation_id: 99 },
    undefined,
    async (url, options) => {
      const parsed = new URL(url)
      assert.equal(parsed.origin + parsed.pathname, 'https://api.zknoir.com/v1/shield-win/entries')
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
        list: [entry(), { ...entry({ id: 4, draw_result: 'NOT_WON' }), reward_amount: undefined, reward_asset: undefined, reward_status: undefined }],
        total: 2,
        page_size: 20,
        page_number: 1,
        has_next_page: false
      }
    })
  )
  assert.equal(won.list[0].usd_value, '25.50')
  assert.equal(typeof won.list[0].usd_value, 'string')
  assert.equal(won.list[0].operation_id, 98765)
  assert.equal(won.list[1].reward_status, undefined)

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
    await assert.rejects(() => getCampaigns(undefined, fetcher), error => {
      assert.equal(error instanceof ShieldWinApiError, false)
      return true
    })
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
    () => getCampaigns(undefined, async () => {
      throw new TypeError('Failed to fetch')
    }),
    { message: 'Shield & Win could not be reached.' }
  )
})

test('cancellation stays an AbortError', async () => {
  const controller = new AbortController()
  const pending = getCampaigns(
    controller.signal,
    async (_url, options) =>
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
          once: true
        })
      })
  )
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
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
  const css = readFileSync(new URL('../src/shield-and-win/shield-and-win.css', import.meta.url), 'utf8')
  assert.match(page, /sk-title/)
  assert.match(page, /aria-label="Disconnect"/)
  assert.match(page, /NEAR Confidential/)
  assert.match(page, /Claim window/)
  assert.match(page, /Full terms and eligibility restrictions apply/)
  assert.equal(page.includes('Loading the campaign.'), false)
  assert.equal(page.includes('1 in 4,444'), false)
  assert.equal(page.includes('nep141:'), false)
  assert.equal(page.includes('$10'), false)
  assert.equal(page.includes('1 ZEC'), false)
  assert.match(css, /dialog\.rules\[open\]/)
  assert.match(css, /\.rules-scroll/)
  assert.match(css, /overflow:\s*hidden/)
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
    const message = claimMessage({ entryId: 12, walletAddress: '0xAbC', zcashAddress: address('t1', 35) })
    assert.equal(await signClaim(provider, '0xAbC', message), `0x${'aa'.repeat(65)}`)
    assert.deepEqual(calls[2], { method: 'personal_sign', params: [utf8ToHex(message), '0xAbC'] })
    for (const method of ['wallet_openCampaign', 'wallet_getCampaignStatus', 'shield_transfer', 'zcash_getAddresses']) {
      assert.equal(calls.some(args => args.method === method), false)
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
  subscribeAccounts({ request: async () => [], on() { listened = true } }, () => {})()
  assert.equal(listened, false)

  const keystone = 'Keystone EVM signing is available only from the Noir Wallet transaction screen.'
  assert.equal(walletErrorMessage({ code: 4200, message: keystone }), keystone)
  assert.equal(
    walletErrorMessage({ code: 4001, message: 'User rejected the request.' }),
    'The request was rejected in Noir Wallet.'
  )
  const signature = `0x${'ab'.repeat(65)}`
  assert.equal(walletErrorMessage({ message: signature }).includes(signature), false)
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  assert.equal(walletErrorMessage(new Error(seed)).includes('abandon'), false)
})
