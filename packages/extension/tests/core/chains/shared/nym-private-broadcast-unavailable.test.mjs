import assert from 'node:assert/strict'
import { test } from 'node:test'

// This file leaves __NYM_PRIVATE_BROADCAST__ undefined, as release builds do.
const { readNymPrivateBroadcastEnabled } =
  await import('../../../../src/infrastructure/chains/nym-private-broadcast-preferences.ts')
const { lookupTransaction } = await import('../../../../src/lib/zcash-node-rpc.ts')
const { setNymPrivateFetchRelay } = await import('../../../../src/core/nym/private-fetch-relay.ts')

const NODE = 'https://node.example'
const TXID = 'ab'.repeat(32)

test('a build without the Nym tunnel ignores a stored Nym preference', async t => {
  const originalChrome = globalThis.chrome
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.chrome = originalChrome
    globalThis.fetch = originalFetch
  })
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return {
            [key]: JSON.stringify({ state: { nymPrivateBroadcastEnabled: true }, version: 0 })
          }
        }
      }
    }
  }
  const directCalls = []
  globalThis.fetch = async input => {
    directCalls.push(String(input))
    return Response.json({ result: { txid: TXID, confirmations: 2 } })
  }
  setNymPrivateFetchRelay(async () => {
    throw new Error('relay must not be used')
  })

  assert.equal(await readNymPrivateBroadcastEnabled(), false)
  assert.deepEqual(await lookupTransaction(NODE, TXID), { status: 'confirmed', confirmations: 2 })
  assert.deepEqual(directCalls, [NODE])
})
