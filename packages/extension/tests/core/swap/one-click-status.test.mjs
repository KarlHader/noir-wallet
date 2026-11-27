import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OneClickStatusClient,
  oneClickTokenKey,
  parseOneClickChallenge
} from '../../../src/core/services/near-intents/one-click-status-client.ts'
import { FetchHttpError, FetchTimeoutError } from '../../../src/lib/fetch-utils.ts'

const now = Date.parse('2026-11-25T00:00:00Z')
const statement = 'Rhea 1Click Order Status Read Authorization v1'
const message = `${statement}\nNonce: 0123456789abcdef`
const scope = {
  endpoint: 'https://example.test/proxy/1click/v0',
  network: 'mainnet',
  walletId: 'wallet-1',
  accountId: 'account-1',
  viewer: { chainFamily: 'evm', walletAddress: `0x${'a'.repeat(40)}`, signingMode: 'public' }
}
const order = { depositAddress: 'depositAddress', depositMemo: '  memo +&=  ' }
const challenge = {
  challengeId: 'challenge-id',
  signingMethod: 'personal_sign',
  expiresAt: new Date(now + 60_000).toISOString(),
  signingInput: { message }
}

function fixture() {
  const saved = new Map()
  const tokens = {
    read: async account => saved.get(oneClickTokenKey(account)) ?? null,
    write: async (account, token) => saved.set(oneClickTokenKey(account), token),
    invalidate: async (account, rejected) => {
      const key = oneClickTokenKey(account)
      if (saved.get(key) === rejected) saved.delete(key)
    }
  }
  let signatures = 0
  let requests = 0
  let rejectToken = null
  let failStatus = null
  let currentTime = now
  const request = async (url, init) => {
    if (url.pathname.endsWith('/challenge')) {
      assert.deepEqual(JSON.parse(init.body), {
        chainFamily: scope.viewer.chainFamily,
        walletAddress: scope.viewer.walletAddress
      })
      return { data: challenge }
    }
    if (url.pathname.endsWith('/verify')) {
      assert.deepEqual(JSON.parse(init.body), {
        challengeId: challenge.challengeId,
        proof: { signature: 'test-signature' }
      })
      return { data: { token: `token-${signatures}` } }
    }
    requests += 1
    assert.equal(url.pathname, '/proxy/1click/v0/status/owner')
    assert.equal(url.searchParams.get('depositAddress'), order.depositAddress)
    assert.equal(url.searchParams.get('depositMemo'), order.depositMemo)
    if (init.headers.Authorization === `Bearer ${rejectToken}`) throw new FetchHttpError(401, '')
    if (failStatus === 'timeout') throw new FetchTimeoutError(15_000)
    if (failStatus !== null) throw new FetchHttpError(failStatus, '')
    return { status: 'SUCCESS' }
  }

  const client = (locked = false) =>
    new OneClickStatusClient({
      tokens,
      now: () => currentTime,
      request,
      resolveSigner: async () =>
        locked
          ? null
          : async input => {
              assert.equal(input.message, message)
              signatures += 1
              return { signature: 'test-signature' }
            }
    })
  return {
    client,
    signatures: () => signatures,
    requests: () => requests,
    reject: token => {
      rejectToken = token
    },
    fail: status => {
      failStatus = status
    },
    advance: delay => {
      currentTime += delay
    }
  }
}

test('1Click order status reuses one proof across concurrent orders and starts locked with a stored token', async () => {
  const harness = fixture()
  const client = harness.client()
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => client.query(scope, order)))
  assert.deepEqual(
    outcomes,
    Array.from({ length: 4 }, () => ({ status: 'SUCCESS' }))
  )
  assert.equal(harness.signatures(), 1)
  const locked = harness.client(true)
  assert.deepEqual(await locked.query(scope, order), { status: 'SUCCESS' })
  for (const other of [
    { ...scope, network: 'testnet' },
    { ...scope, walletId: 'wallet-2' },
    { ...scope, accountId: 'account-2' },
    { ...scope, endpoint: 'https://another.test/proxy/1click/v0' },
    { ...scope, viewer: { ...scope.viewer, walletAddress: `0x${'b'.repeat(40)}` } }
  ])
    assert.equal(await locked.query(other, order), null)
  assert.equal(harness.signatures(), 1)
})

test('1Click replaces a rejected token once without re-signing for missing orders or service downtime', async () => {
  const harness = fixture()
  const client = harness.client()
  await client.query(scope, order)
  harness.reject('token-1')
  assert.deepEqual(await client.query(scope, order), { status: 'SUCCESS' })
  assert.equal(harness.signatures(), 2)
  harness.fail(404)
  assert.equal(await client.query(scope, order), null)
  for (const failure of [503, 'timeout']) {
    harness.fail(failure)
    assert.equal(await client.query(scope, order), null)
    const requests = harness.requests()
    assert.equal(await client.query(scope, order), null)
    assert.equal(harness.requests(), requests)
    harness.advance(31_000)
    harness.fail(null)
    assert.deepEqual(await client.query(scope, order), { status: 'SUCCESS' })
  }
  assert.equal(harness.signatures(), 2)
})

test('1Click polls with explicit device authorization without invoking the device again', async () => {
  const harness = fixture()
  const client = harness.client(true)
  const signedChallenges = []
  assert.equal(await client.query(scope, order), null)
  assert.equal(
    await client.authorizeOwner(scope, async input => {
      signedChallenges.push(input.message)
      return { signature: 'test-signature' }
    }),
    true
  )
  assert.deepEqual(await harness.client(true).query(scope, order), { status: 'SUCCESS' })
  harness.reject('token-0')
  assert.equal(await client.query(scope, order), null)
  assert.deepEqual(signedChallenges, [message])
})

test('1Click signs only the documented challenge and decodes a NEAR nonce without rewriting the message', () => {
  const withMessage = value => ({ data: { ...challenge, signingInput: { message: value } } })
  assert.throws(() => parseOneClickChallenge(withMessage(`${message}\nTransfer funds`), 'evm', now))
  assert.throws(() => parseOneClickChallenge({ data: challenge }, 'evm', now + 60_000))
  const nonce = new Uint8Array(32).fill(7)
  const near = parseOneClickChallenge(
    {
      data: {
        ...challenge,
        signingMethod: 'NEP-413',
        signingInput: {
          message: statement,
          recipient: 'rhea.near',
          nonce: Buffer.from(nonce).toString('base64')
        }
      }
    },
    'near',
    now
  )
  assert.equal(near.message, statement)
  assert.equal(near.near.recipient, 'rhea.near')
  assert.deepEqual(near.near.nonce, nonce)
})
