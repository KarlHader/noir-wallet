import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createSigningJournal } from '../../../src/lib/multisig-signing-storage'
import {
  parseSigningIntent,
  type SigningIntentBinding
} from '../../../src/core/multisig/signing-journal'
import {
  MULTISIG_SIGNING_STORAGE_KEY,
  clearMultisigData
} from '../../../src/lib/multisig-group-storage'
import {
  deleteMultisigDataForAccount,
  deleteMultisigDataForWallet
} from '../../../src/lib/multisig-vault-storage'
import { commitAccountMetadataDeletion } from '../../../src/lib/wallet-metadata-storage'
import { installStorageEnv, reorderStorageObjectKeys } from './helpers/storage-env'

const NOW = 1_800_000_000_000
const BINDING: SigningIntentBinding = {
  walletId: 'w',
  accountId: 'a',
  network: 'testnet',
  groupId: 'group',
  rosterVersion: 1,
  reviewId: 'review-1',
  pcztDigest: 'ab'.repeat(32),
  sessionId: 'AAAAAAAAAAAAAAAAAAAAAA==',
  threshold: '2-of-3',
  selectedSlots: [0, 2],
  expiresAt: NOW + 300_000,
  transport: 'qr',
  createdAt: NOW
}
const START = {
  expectedPhase: 'review_ready',
  expectedNoncePhase: 'none',
  nextPhase: 'signing',
  nextNoncePhase: 'none'
} as const
const CREATED = {
  expectedPhase: 'signing',
  expectedNoncePhase: 'none',
  nextPhase: 'signing',
  nextNoncePhase: 'created'
} as const
const COMMITTED = {
  expectedPhase: 'signing',
  expectedNoncePhase: 'created',
  nextPhase: 'signing',
  nextNoncePhase: 'committed'
} as const
const CONSUMED = {
  expectedPhase: 'signing',
  expectedNoncePhase: 'committed',
  nextPhase: 'signing',
  nextNoncePhase: 'consumed'
} as const
let env: ReturnType<typeof installStorageEnv>
beforeEach(() => {
  env = installStorageEnv()
})
afterEach(() => {
  env.restore()
})

function nextBinding(n: number, accountId = 'a'): SigningIntentBinding {
  return {
    ...BINDING,
    accountId,
    reviewId: `review-${n}`,
    sessionId: Buffer.from(n.toString(16).padStart(32, '0'), 'hex').toString('base64')
  }
}
function storage() {
  return chrome.storage.local
}

test('acknowledges two signing scopes when Chrome recursively reorders object keys', async () => {
  const journal = createSigningJournal()
  const original = storage().set
  storage().set = async items =>
    original(reorderStorageObjectKeys(items) as Record<string, unknown>)
  try {
    const last = nextBinding(2, 'z'),
      first = nextBinding(3, 'a')
    await journal.reserveSigningIntent(last, NOW)
    await journal.reserveSigningIntent(first, NOW)
    await journal.advanceSigningIntent(last, START, NOW + 1)
    await journal.advanceSigningIntent(last, CREATED, NOW + 2)
    assert.deepEqual((await journal.listSigningIntents()).map(intent => intent.accountId).sort(), [
      'a',
      'z'
    ])
    assert.equal((await journal.readSigningIntent(last))?.noncePhase, 'created')
  } finally {
    storage().set = original
  }
})

test('withholds signing acknowledgement for changed binding, extra fields or reordered journal arrays', async () => {
  const journal = createSigningJournal()
  for (let n = 1; n <= 2; n++) {
    const createdAt = NOW + n * 10
    const binding = { ...nextBinding(n), createdAt, expiresAt: createdAt + 8 }
    await journal.reserveSigningIntent(binding, createdAt)
    for (const [index, edge] of [START, CREATED, COMMITTED, CONSUMED].entries())
      await journal.advanceSigningIntent(binding, edge, createdAt + index + 1)
    await journal.advanceSigningIntent(
      binding,
      {
        expectedPhase: 'signing',
        expectedNoncePhase: 'consumed',
        nextPhase: 'cancelled',
        nextNoncePhase: 'consumed'
      },
      createdAt + 5
    )
  }
  const previous = { ...nextBinding(3), createdAt: NOW + 40 }
  await journal.reserveSigningIntent(previous, NOW + 40)
  await journal.advanceSigningIntent(
    previous,
    {
      expectedPhase: 'review_ready',
      expectedNoncePhase: 'none',
      nextPhase: 'cancelled',
      nextNoncePhase: 'none'
    },
    NOW + 41
  )
  const current = { ...nextBinding(4), createdAt: NOW + 50 }
  await journal.reserveSigningIntent(current, NOW + 50)
  const before = structuredClone(env.store.get(MULTISIG_SIGNING_STORAGE_KEY))
  type AccountMap = Record<
    string,
    {
      records: Record<string, unknown>[]
      tombstones: Record<string, unknown>[]
    }
  >
  const mutations = [
    (account: AccountMap[string]) => {
      account.records[1].pcztDigest = 'cd'.repeat(32)
    },
    (account: AccountMap[string]) => {
      account.records[1].pczt = 'unexpected-payload'
    },
    (account: AccountMap[string]) => {
      account.tombstones[0].noncePhase = 'none'
    },
    (account: AccountMap[string]) => {
      account.tombstones.reverse()
    },
    (account: AccountMap[string]) => {
      account.records.reverse()
    }
  ]
  const original = storage().set
  try {
    for (const mutate of mutations) {
      env.store.set(MULTISIG_SIGNING_STORAGE_KEY, structuredClone(before))
      storage().set = async items => {
        const changed = reorderStorageObjectKeys(items) as Record<string, unknown>
        const map = changed[MULTISIG_SIGNING_STORAGE_KEY] as AccountMap
        mutate(map['["testnet","w","a"]'])
        await original(changed)
      }
      await assert.rejects(journal.advanceSigningIntent(current, START, NOW + 51))
    }
  } finally {
    storage().set = original
    env.store.set(MULTISIG_SIGNING_STORAGE_KEY, before)
  }
  assert.equal((await journal.advanceSigningIntent(current, START, NOW + 51)).phase, 'signing')
})

test('simultaneous signing reservations grant only one account owner and retain other scopes', async () => {
  const first = createSigningJournal(),
    second = createSigningJournal()
  const results = await Promise.allSettled([
    first.reserveSigningIntent(BINDING, NOW),
    second.reserveSigningIntent(nextBinding(2), NOW)
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await second.reserveSigningIntent(nextBinding(3, 'b'), NOW)
  assert.equal((await first.listSigningIntents()).length, 2)
})

test('network or group changes cannot bypass an existing account signing slot', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  await assert.rejects(
    journal.reserveSigningIntent(
      { ...nextBinding(2), network: 'mainnet', groupId: 'other' },
      NOW + 1
    )
  )
  assert.equal((await journal.listSigningIntents()).length, 1)
})

test('public intent validation rejects secrets, malformed sessions and unsupported signer combinations', async () => {
  const journal = createSigningJournal()
  for (const patch of [
    { pczt: 'private' },
    { signature: 'private' },
    { sessionId: 'AA==' },
    { sessionId: 'AAAAAAAAAAAAAAAAAAAAAB==' },
    { selectedSlots: [1, 2] },
    { selectedSlots: [0, 0] },
    { selectedSlots: [0, 3] },
    { threshold: '3-of-3', selectedSlots: [0, 1] },
    { threshold: '2-of-2', selectedSlots: [0, 2] }
  ])
    await assert.rejects(
      journal.reserveSigningIntent({ ...BINDING, ...patch } as SigningIntentBinding, NOW)
    )
  assert.equal(env.store.has(MULTISIG_SIGNING_STORAGE_KEY), false)
  const intent = await journal.reserveSigningIntent(BINDING, NOW)
  assert.deepEqual(parseSigningIntent(intent).selectedSlots, [0, 2])
  assert.equal(Object.isFrozen(intent.selectedSlots), true)
})

test('nonce progression rejects skips, regression, immutable binding changes and stale replay', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  await journal.advanceSigningIntent(BINDING, START, NOW + 1)
  await assert.rejects(
    journal.advanceSigningIntent(BINDING, { ...CREATED, nextNoncePhase: 'consumed' }, NOW + 2)
  )
  await journal.advanceSigningIntent(BINDING, CREATED, NOW + 2)
  await journal.advanceSigningIntent(BINDING, CREATED, NOW + 3) // Lost acknowledgement, same durable edge.
  await assert.rejects(
    journal.advanceSigningIntent({ ...BINDING, pcztDigest: 'cd'.repeat(32) }, COMMITTED, NOW + 3)
  )
  await assert.rejects(
    journal.advanceSigningIntent({ ...BINDING, network: 'mainnet' }, COMMITTED, NOW + 3)
  )
  await journal.advanceSigningIntent(BINDING, COMMITTED, NOW + 4)
  await assert.rejects(journal.advanceSigningIntent(BINDING, CREATED, NOW + 5))
  await assert.rejects(
    journal.advanceSigningIntent(BINDING, { ...CONSUMED, nextNoncePhase: 'none' }, NOW + 5)
  )
  assert.equal((await journal.readSigningIntent(BINDING))?.noncePhase, 'committed')
})

test('failed storage acknowledgement never advances nonce authority or permits a competing session', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  await journal.advanceSigningIntent(BINDING, START, NOW + 1)
  const original = storage().set
  storage().set = async () => {}
  try {
    await assert.rejects(journal.advanceSigningIntent(BINDING, CREATED, NOW + 2), /saved/)
  } finally {
    storage().set = original
  }
  assert.equal((await journal.readSigningIntent(BINDING))?.noncePhase, 'none')
  await assert.rejects(createSigningJournal().reserveSigningIntent(nextBinding(2), NOW + 2))
  await journal.advanceSigningIntent(BINDING, CREATED, NOW + 3)
})

test('lost readback after a durable nonce write requires retry before acknowledgement', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  await journal.advanceSigningIntent(BINDING, START, NOW + 1)
  const originalSet = storage().set,
    originalGet = storage().get
  storage().set = async items => {
    await originalSet(items)
    storage().get = async () => {
      storage().get = originalGet
      throw new Error('readback unavailable')
    }
  }
  try {
    await assert.rejects(journal.advanceSigningIntent(BINDING, CREATED, NOW + 2), /readback/)
  } finally {
    storage().set = originalSet
    storage().get = originalGet
  }
  assert.equal((await journal.readSigningIntent(BINDING))?.noncePhase, 'created')
  const acknowledged = await journal.advanceSigningIntent(BINDING, CREATED, NOW + 3)
  assert.equal(acknowledged.noncePhase, 'created')
  assert.equal(acknowledged.updatedAt, NOW + 2)
})

test('reservation quota failure grants no local authority and cannot erase retained history', async () => {
  const journal = createSigningJournal()
  const original = storage().set
  storage().set = async () => {
    throw new Error('quota')
  }
  try {
    await assert.rejects(journal.reserveSigningIntent(BINDING, NOW), /quota/)
  } finally {
    storage().set = original
  }
  assert.equal(env.store.has(MULTISIG_SIGNING_STORAGE_KEY), false)
  await assert.rejects(journal.advanceSigningIntent(BINDING, START, NOW + 1))
  await journal.reserveSigningIntent(BINDING, NOW + 2)
})

test('more than 128 expired terminal sessions compact without losing nonce or replay markers', async () => {
  const journal = createSigningJournal()
  const historical: SigningIntentBinding[] = []
  for (let n = 1; n <= 129; n++) {
    const createdAt = NOW + n * 10
    const binding = { ...nextBinding(n), createdAt, expiresAt: createdAt + 5 }
    historical.push(binding)
    await journal.reserveSigningIntent(binding, createdAt)
    for (const [index, edge] of [START, CREATED, COMMITTED, CONSUMED].entries())
      await journal.advanceSigningIntent(binding, edge, createdAt + index + 1)
    await journal.advanceSigningIntent(
      binding,
      {
        expectedPhase: 'signing',
        expectedNoncePhase: 'consumed',
        nextPhase: 'cancelled',
        nextNoncePhase: 'consumed'
      },
      createdAt + 4
    )
  }
  const current = { ...nextBinding(3000), createdAt: NOW + 1400, expiresAt: NOW + 1700 }
  await journal.reserveSigningIntent(current, current.createdAt)
  assert.equal((await journal.listSigningIntents()).length, 1)
  assert.equal(await journal.readSigningIntent(historical[0]), null)
  const stored = env.store.get(MULTISIG_SIGNING_STORAGE_KEY) as Record<
    string,
    { tombstones: { sessionId: string; noncePhase: string }[] }
  >
  const markers = stored['["testnet","w","a"]'].tombstones
  assert.equal(markers.length, 129)
  assert.equal(
    markers.every(marker => marker.noncePhase === 'consumed'),
    true
  )
  await journal.advanceSigningIntent(
    current,
    {
      expectedPhase: 'review_ready',
      expectedNoncePhase: 'none',
      nextPhase: 'cancelled',
      nextNoncePhase: 'none'
    },
    NOW + 1401
  )
  await assert.rejects(
    journal.reserveSigningIntent(
      { ...historical[0], createdAt: NOW + 1402, expiresAt: NOW + 1700 },
      NOW + 1402
    )
  )
  await assert.rejects(
    journal.reserveSigningIntent(
      {
        ...nextBinding(4000),
        reviewId: historical[0].reviewId,
        createdAt: NOW + 1402,
        expiresAt: NOW + 1700
      },
      NOW + 1402
    )
  )
})

test('restart cannot resume a nonce round and interruption retains consumed history without broadcast claims', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  for (const [index, edge] of [START, CREATED, COMMITTED, CONSUMED].entries())
    await journal.advanceSigningIntent(BINDING, edge, NOW + index + 1)
  await journal.advanceSigningIntent(
    BINDING,
    {
      expectedPhase: 'signing',
      expectedNoncePhase: 'consumed',
      nextPhase: 'signed',
      nextNoncePhase: 'consumed'
    },
    NOW + 5
  )
  const restarted = createSigningJournal()
  await assert.rejects(
    restarted.reserveSigningIntent(
      { ...nextBinding(2), createdAt: BINDING.expiresAt + 1, expiresAt: BINDING.expiresAt + 1000 },
      BINDING.expiresAt + 1
    )
  )
  assert.equal((await restarted.readSigningIntent(BINDING))?.phase, 'signed')
  await assert.rejects(
    restarted.advanceSigningIntent(
      BINDING,
      {
        expectedPhase: 'signed',
        expectedNoncePhase: 'consumed',
        nextPhase: 'cancelled',
        nextNoncePhase: 'consumed'
      },
      NOW + 6
    )
  )
  await restarted.interruptSigningIntents(undefined, NOW + 6)
  const previous = await restarted.readSigningIntent(BINDING)
  assert.equal(previous?.phase, 'interrupted')
  assert.equal(previous?.noncePhase, 'consumed')
  assert.equal(Object.hasOwn(previous!, 'txid'), false)
  await assert.rejects(restarted.reserveSigningIntent(BINDING, NOW + 7))
  await assert.rejects(
    restarted.reserveSigningIntent({ ...nextBinding(2), reviewId: BINDING.reviewId }, NOW + 7)
  )
  await restarted.reserveSigningIntent(nextBinding(2), NOW + 7)
})

test('cancellation preserves nonce use and expiry cannot produce signed state', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  await journal.advanceSigningIntent(BINDING, START, NOW + 1)
  await journal.advanceSigningIntent(BINDING, CREATED, NOW + 2)
  await journal.advanceSigningIntent(
    BINDING,
    {
      expectedPhase: 'signing',
      expectedNoncePhase: 'created',
      nextPhase: 'cancelled',
      nextNoncePhase: 'created'
    },
    NOW + 3
  )
  assert.equal((await journal.readSigningIntent(BINDING))?.noncePhase, 'created')
  await assert.rejects(journal.advanceSigningIntent(BINDING, CREATED, NOW + 4))
  const next = nextBinding(2)
  await journal.reserveSigningIntent(next, NOW + 4)
  await assert.rejects(journal.advanceSigningIntent(next, START, BINDING.expiresAt))
  await journal.advanceSigningIntent(
    next,
    {
      expectedPhase: 'review_ready',
      expectedNoncePhase: 'none',
      nextPhase: 'expired',
      nextNoncePhase: 'none'
    },
    BINDING.expiresAt
  )
})

test('authoritative tombstone prevents stale reserve or nonce progress after account cleanup', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  await journal.advanceSigningIntent(BINDING, START, NOW + 1)
  env.store.set('wallet_state', {
    state: { wallets: [{ id: 'w', accounts: [{ id: 'a', derivationIndex: 0 }] }] }
  })
  await commitAccountMetadataDeletion('w', 'a', 'testnet', 0)
  await deleteMultisigDataForAccount('w', 'a')
  await assert.rejects(journal.advanceSigningIntent(BINDING, CREATED, NOW + 2), /metadata/)
  await assert.rejects(
    createSigningJournal().reserveSigningIntent(nextBinding(2), NOW + 2),
    /metadata/
  )
  assert.deepEqual(env.store.get(MULTISIG_SIGNING_STORAGE_KEY), {})
})

test('concurrent metadata deletion and reserve cannot restore a deleted account journal', async () => {
  env.store.set('wallet_state', {
    state: { wallets: [{ id: 'w', accounts: [{ id: 'a', derivationIndex: 0 }] }] }
  })
  const journal = createSigningJournal()
  await Promise.all([
    journal.reserveSigningIntent(BINDING, NOW),
    (async () => {
      await commitAccountMetadataDeletion('w', 'a', 'testnet', 0)
      await deleteMultisigDataForAccount('w', 'a')
    })()
  ])
  assert.deepEqual(env.store.get(MULTISIG_SIGNING_STORAGE_KEY), {})
  await assert.rejects(journal.advanceSigningIntent(BINDING, START, NOW + 1), /metadata/)
})

test('account, wallet and reset cleanup remove signing metadata using the shared scope map', async () => {
  const journal = createSigningJournal()
  for (const binding of [BINDING, nextBinding(2, 'ab'), { ...nextBinding(3), walletId: 'w2' }])
    await journal.reserveSigningIntent(binding, NOW)
  await deleteMultisigDataForAccount('w', 'a')
  assert.equal((await journal.listSigningIntents()).length, 2)
  await deleteMultisigDataForWallet('w')
  assert.equal((await journal.listSigningIntents())[0].walletId, 'w2')
  await clearMultisigData()
  assert.equal(env.store.has(MULTISIG_SIGNING_STORAGE_KEY), false)
})

test('malformed interruption scope cannot expand into a global cancellation', async () => {
  const journal = createSigningJournal()
  await journal.reserveSigningIntent(BINDING, NOW)
  await assert.rejects(journal.interruptSigningIntents(null as never, NOW + 1))
  assert.equal((await journal.readSigningIntent(BINDING))?.phase, 'review_ready')
})

test('legal colon-bearing domain IDs remain independent through exact account cleanup', async () => {
  const journal = createSigningJournal()
  const actual = {
    ...BINDING,
    walletId: 'key-domain:frost-mv3-uuid',
    accountId: 'account:frost-uuid'
  }
  await journal.reserveSigningIntent(actual, NOW)
  await journal.advanceSigningIntent(actual, START, NOW + 1)
  const first = { ...nextBinding(2), walletId: 'w:x', accountId: 'a' }
  const second = { ...nextBinding(3), walletId: 'w', accountId: 'x:a' }
  await journal.reserveSigningIntent(first, NOW)
  await journal.reserveSigningIntent(second, NOW)
  await deleteMultisigDataForAccount('w:x', 'a')
  assert.equal(await journal.readSigningIntent(first), null)
  assert.equal((await journal.readSigningIntent(second))?.phase, 'review_ready')
  await journal.interruptSigningIntents(
    { network: actual.network, walletId: actual.walletId, accountId: actual.accountId },
    NOW + 2
  )
  assert.equal((await journal.readSigningIntent(actual))?.phase, 'interrupted')
})
