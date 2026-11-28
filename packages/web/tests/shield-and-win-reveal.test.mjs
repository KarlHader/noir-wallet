import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readStored, removeStored, writeStored } from '../src/lib/storage.ts'
import { revealDemoEntry } from '../src/shield-and-win/reveal-demo.ts'
import { MAX_REVEALS, needsReveal, readReveals, saveReveal } from '../src/shield-and-win/reveals.ts'

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem(key) {
      return items.has(key) ? items.get(key) : null
    },
    setItem(key, value) {
      items.set(key, value)
    },
    removeItem(key) {
      items.delete(key)
    }
  }
}

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

function entry(id, draw_result, reward_status) {
  return {
    id,
    operation_id: id * 10,
    campaign_id: 1,
    destination_asset: 'nep141:eth.omft.near',
    usd_value: '12.40',
    draw_result,
    ...(draw_result === 'WON' ? { reward_amount: '0.1', reward_asset: 'ZEC', reward_status } : {}),
    shield_completed_at: 1795840000000 + id
  }
}

test('stored values survive missing, blocked or corrupt storage', () => {
  const storage = memoryStorage()
  const parse = value => (typeof value === 'object' && value !== null ? value : null)
  assert.equal(readStored('a.v1', parse, storage), null)
  writeStored('a.v1', { n: 1 }, storage)
  assert.deepEqual(readStored('a.v1', parse, storage), { n: 1 })
  removeStored('a.v1', storage)
  assert.equal(readStored('a.v1', parse, storage), null)
  assert.equal(readStored('a.v1', parse, memoryStorage({ 'a.v1': '{' })), null)
  assert.equal(readStored('a.v1', parse, memoryStorage({ 'a.v1': '7' })), null)
  assert.equal(readStored('a.v1', parse, denied), null)
  assert.doesNotThrow(() => writeStored('a.v1', 1, denied))
  assert.doesNotThrow(() => removeStored('a.v1', denied))
  assert.equal(readStored('a.v1', parse, null), null)
})

test('a draw needs a reveal until it is revealed or its claim has started', () => {
  const none = new Set()
  assert.equal(needsReveal(entry(1, 'NOT_WON'), none), true)
  assert.equal(needsReveal(entry(2, 'WON', 'UNCLAIMED'), none), true)
  for (const status of ['CLAIMING', 'SENDING', 'COMPLETED', 'FAILED']) {
    assert.equal(needsReveal(entry(3, 'WON', status), none), false, status)
  }
  const revealed = new Set([1, 2])
  assert.equal(needsReveal(entry(1, 'NOT_WON'), revealed), false)
  assert.equal(needsReveal(entry(2, 'WON', 'UNCLAIMED'), revealed), false)
})

test('reveals are saved in this browser and read back', () => {
  const storage = memoryStorage()
  assert.deepEqual([...readReveals(storage)], [])
  let revealed = saveReveal(7, readReveals(storage), storage)
  revealed = saveReveal(9, revealed, storage)
  revealed = saveReveal(7, revealed, storage)
  assert.deepEqual([...revealed], [9, 7])
  assert.deepEqual([...readReveals(storage)], [9, 7])
  assert.equal(storage.items.get('shield-win.reveals.v1'), '{"ids":[9,7]}')
})

test('bad stored reveals are dropped, and only the newest are kept', () => {
  const messy = memoryStorage({
    'shield-win.reveals.v1': JSON.stringify({ ids: [3, -1, 0, 2.5, '4', null, 5] })
  })
  assert.deepEqual([...readReveals(messy)], [3, 5])
  assert.deepEqual([...readReveals(memoryStorage({ 'shield-win.reveals.v1': '[' }))], [])
  assert.deepEqual([...readReveals(denied)], [])
  assert.deepEqual([...readReveals(null)], [])
  // A blocked storage still reveals for this visit
  assert.deepEqual([...saveReveal(4, new Set(), denied)], [4])

  const full = new Set(Array.from({ length: MAX_REVEALS }, (_, index) => index + 1))
  const storage = memoryStorage()
  const next = saveReveal(MAX_REVEALS + 1, full, storage)
  assert.equal(next.size, MAX_REVEALS)
  assert.equal(next.has(1), false)
  assert.equal(next.has(MAX_REVEALS + 1), true)
  assert.equal(readReveals(storage).size, MAX_REVEALS)
})

test('the reveal demo runs on branch previews and locally, never on the live site', () => {
  const win = revealDemoEntry('feat-shield-win-reveal.noir-wallet.pages.dev', '?reveal-demo=win')
  assert.equal(win?.draw_result, 'WON')
  assert.equal(win?.reward_status, 'UNCLAIMED')
  assert.equal(revealDemoEntry('localhost', '?reveal-demo=lose')?.draw_result, 'NOT_WON')
  assert.equal(revealDemoEntry('127.0.0.1', '?reveal-demo=win')?.draw_result, 'WON')
  for (const host of [
    'www.zknoir.com',
    'zknoir.com',
    'noir-wallet.pages.dev',
    'feat.noir-wallet.pages.dev.example.com',
    'example.com'
  ]) {
    assert.equal(revealDemoEntry(host, '?reveal-demo=win'), null, host)
  }
  assert.equal(revealDemoEntry('localhost', ''), null)
  assert.equal(revealDemoEntry('localhost', '?reveal-demo=jackpot'), null)
})
