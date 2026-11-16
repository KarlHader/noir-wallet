import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import {
  cancelAllLedgerSigning,
  configureLedgerSigningCoordinator,
  getLedgerSigningRequest,
  registerLedgerSigningTabLifecycle,
  requestLedgerSignature,
  submitLedgerSigningResponse
} from '../../../src/background/ledger-signing-coordinator.ts'
import { ledgerEvmPersonalSummary } from '../../../src/background/ledger-evm-dapp-review.ts'
import { ledgerBitcoinMessageSummary } from '../../../src/background/ledger-bitcoin-dapp-review.ts'
import { getBitcoinChainId } from '../../../src/core/chains/registry/index.ts'
import { parseLedgerPendingSigning } from '../../../src/core/keyring/protocol/ledger-signing.ts'

const records = new Map()
const removedListeners = []
const tabs = []
const notifications = []
let nextTabId = 10
let scopeAllowed = true
let payloadAllowed = true
let failRemoval = false
let removalGate = null
let removalStarted = null

globalThis.chrome = {
  storage: {
    session: {
      async set(items) {
        for (const [key, value] of Object.entries(items)) records.set(key, value)
      },
      async remove(key) {
        if (removalGate) {
          removalStarted?.()
          await removalGate
        }
        if (failRemoval) throw new Error('Session storage unavailable')
        records.delete(key)
      }
    }
  },
  tabs: {
    async create(input) {
      const tab = { id: nextTabId++, ...input }
      tabs.push(tab)
      return tab
    },
    async remove(id) {
      for (const listener of removedListeners) listener(id)
    },
    onRemoved: {
      addListener(listener) {
        removedListeners.push(listener)
      }
    }
  },
  runtime: {
    getURL(path) {
      return `chrome-extension://wallet/${path}`
    },
    async sendMessage(message) {
      notifications.push(message)
    }
  }
}

configureLedgerSigningCoordinator(async () => {
  if (!scopeAllowed) throw new Error('Active account changed')
})
registerLedgerSigningTabLifecycle()

const scope = { keyDomainId: 'key-domain:ledger', accountId: 'account:ledger', chainId: 'eip155:1' }
const request = {
  kind: 'personal-sign',
  derivationPath: "m/44'/60'/0'/0/0",
  expectedAddress: '0x0000000000000000000000000000000000000001',
  messageHex: '0x6869'
}

async function begin(overrides = {}) {
  const summary = await ledgerEvmPersonalSummary(
    scope.chainId,
    request.expectedAddress,
    new TextEncoder().encode('hi')
  )
  const binding = {
    scope,
    summary,
    expiresAt: Date.now() + 5_000,
    payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
    validate: async () => {
      if (!payloadAllowed) throw new Error('Signing payload changed')
    },
    ...overrides
  }
  const previousIds = new Set([...records.values()].map(item => item.requestId))
  const promise = requestLedgerSignature({ ...request }, binding)
  void promise.catch(() => {})
  let record
  for (let attempt = 0; attempt < 100; attempt += 1) {
    record = [...records.values()].find(
      item => !previousIds.has(item.requestId) && item.tabId !== undefined
    )
    if (record) break
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.ok(record)
  return { promise, record, binding }
}

afterEach(async () => {
  failRemoval = false
  removalGate = null
  removalStarted = null
  await cancelAllLedgerSigning('Test cleanup')
  records.clear()
  tabs.length = 0
  notifications.length = 0
  scopeAllowed = true
  payloadAllowed = true
})

it('invalidates durable native signing tabs even when no device request is waiting', async () => {
  await cancelAllLedgerSigning('Network mode changed')
  assert.deepEqual(notifications, [{ type: 'LEDGER_SIGNING_CANCELLED' }])
})

it('binds concurrent requests to their own tabs and consumes each response once', async () => {
  const first = await begin()
  const second = await begin()
  assert.notEqual(first.record.requestId, second.record.requestId)
  assert.notEqual(first.record.tabId, second.record.tabId)
  await assert.rejects(
    getLedgerSigningRequest(first.record.requestId, second.record.tabId),
    /tab does not match/
  )
  assert.equal(
    (await getLedgerSigningRequest(first.record.requestId, first.record.tabId)).request.messageHex,
    '0x6869'
  )
  await submitLedgerSigningResponse(
    first.record.requestId,
    { signatureHex: 'first' },
    first.record.tabId
  )
  assert.deepEqual(await first.promise, { signatureHex: 'first' })
  await assert.rejects(
    submitLedgerSigningResponse(
      first.record.requestId,
      { signatureHex: 'again' },
      first.record.tabId
    ),
    /interrupted/
  )
  await submitLedgerSigningResponse(
    second.record.requestId,
    { signatureHex: 'second' },
    second.record.tabId
  )
  assert.deepEqual(await second.promise, { signatureHex: 'second' })
  assert.equal(records.size, 0)
})

it('rechecks scope, payload binding and request bytes before submission', async () => {
  const active = await begin()
  scopeAllowed = false
  await assert.rejects(
    submitLedgerSigningResponse(active.record.requestId, {}, active.record.tabId),
    /Active account changed/
  )
  scopeAllowed = true
  payloadAllowed = false
  await assert.rejects(
    submitLedgerSigningResponse(active.record.requestId, {}, active.record.tabId),
    /Signing payload changed/
  )
  payloadAllowed = true
  active.record.request.messageHex = '0x00'
  await assert.rejects(
    submitLedgerSigningResponse(active.record.requestId, {}, active.record.tabId),
    /payload changed/
  )
  await cancelAllLedgerSigning('Changed request')
  await assert.rejects(active.promise, /Changed request/)
})

it('rejects a pending signing view with a mismatched request chain or summary', async () => {
  const active = await begin()
  assert.equal(parseLedgerPendingSigning(active.record).request.kind, 'personal-sign')
  assert.throws(
    () =>
      parseLedgerPendingSigning({
        ...active.record,
        scope: { ...active.record.scope, chainId: 'near:mainnet' }
      }),
    /chain/
  )
  assert.throws(
    () =>
      parseLedgerPendingSigning({
        ...active.record,
        requestDigest: 'not-a-digest'
      }),
    /digest/
  )
  assert.throws(
    () =>
      parseLedgerPendingSigning({
        ...active.record,
        summary: { ...active.record.summary, schema: 'near.transaction.v1' }
      }),
    /summary/
  )
  assert.throws(
    () => parseLedgerPendingSigning({ ...active.record, origin: 'invalid origin' }),
    /origin/
  )
  assert.throws(
    () => parseLedgerPendingSigning({ ...active.record, expiresAt: Date.now() - 1 }),
    /expired/
  )
})

it('preserves empty and whitespace-bearing BIP-322 messages in pending signing views', async () => {
  const chainId = getBitcoinChainId('mainnet')
  const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'
  for (const message of ['', '  sign this message \n']) {
    const summary = await ledgerBitcoinMessageSummary(chainId, address, message)
    const pending = {
      requestId: crypto.randomUUID(),
      request: {
        kind: 'bip322-simple',
        accountPath: "m/84'/0'/0'",
        masterFingerprintHex: '00000000',
        expectedAddress: address,
        network: 'mainnet',
        message
      },
      scope: { ...scope, chainId },
      payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
      expiresAt: Date.now() + 5_000,
      summary,
      requestDigest: 'b'.repeat(64)
    }
    const parsed = parseLedgerPendingSigning(pending)
    assert.equal(parsed.request.message, message)
    assert.equal(parsed.summary.fields.message.value, message)
  }
})

it('rejects a signature when cancellation arrives during session cleanup', async () => {
  const controller = new AbortController()
  const active = await begin({ signal: controller.signal })
  let releaseRemoval
  const removalEntered = new Promise(resolve => {
    removalStarted = resolve
  })
  removalGate = new Promise(resolve => {
    releaseRemoval = resolve
  })
  try {
    const submission = submitLedgerSigningResponse(
      active.record.requestId,
      { signatureHex: 'signed' },
      active.record.tabId
    )
    await removalEntered
    controller.abort(new Error('Cancelled during cleanup'))
    releaseRemoval()
    await assert.rejects(submission, /Cancelled during cleanup/)
    await assert.rejects(active.promise, /cancelled/i)
  } finally {
    releaseRemoval?.()
    removalGate = null
    removalStarted = null
  }
})

it('rejects a signature when its tab closes during session cleanup', async () => {
  const active = await begin()
  let releaseRemoval
  const removalEntered = new Promise(resolve => {
    removalStarted = resolve
  })
  removalGate = new Promise(resolve => {
    releaseRemoval = resolve
  })
  try {
    const submission = submitLedgerSigningResponse(
      active.record.requestId,
      { signatureHex: 'signed' },
      active.record.tabId
    )
    await removalEntered
    await chrome.tabs.remove(active.record.tabId)
    releaseRemoval()
    await assert.rejects(submission, /interrupted|tab was closed/)
    await assert.rejects(active.promise, /tab was closed/)
  } finally {
    releaseRemoval?.()
    removalGate = null
    removalStarted = null
  }
})

it('blocks duplicate reads and submissions while a signature is being consumed', async () => {
  const active = await begin()
  let releaseRemoval
  const removalEntered = new Promise(resolve => {
    removalStarted = resolve
  })
  removalGate = new Promise(resolve => {
    releaseRemoval = resolve
  })
  try {
    const submission = submitLedgerSigningResponse(
      active.record.requestId,
      { signatureHex: 'first' },
      active.record.tabId
    )
    await removalEntered
    await assert.rejects(
      getLedgerSigningRequest(active.record.requestId, active.record.tabId),
      /already being submitted/
    )
    await assert.rejects(
      submitLedgerSigningResponse(
        active.record.requestId,
        { signatureHex: 'second' },
        active.record.tabId
      ),
      /already being submitted/
    )
    releaseRemoval()
    await submission
    assert.deepEqual(await active.promise, { signatureHex: 'first' })
    assert.equal(records.size, 0)
  } finally {
    releaseRemoval?.()
    removalGate = null
    removalStarted = null
  }
})

it('cancels on abort, tab close and expiry without leaving session records', async () => {
  const controller = new AbortController()
  const aborted = await begin({ signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted.promise, /cancelled/)
  const closed = await begin()
  for (const listener of removedListeners) listener(closed.record.tabId)
  await assert.rejects(closed.promise, /tab was closed/)
  const expiring = await begin({ expiresAt: Date.now() + 30 })
  await assert.rejects(expiring.promise, /expired/)
  assert.equal(records.size, 0)
})

it('does not open a tab when the signal aborts while the request digest is pending', async () => {
  const summary = await ledgerEvmPersonalSummary(
    scope.chainId,
    request.expectedAddress,
    new TextEncoder().encode('hi')
  )
  const controller = new AbortController()
  const originalDigest = crypto.subtle.digest
  let releaseDigest
  let digestStarted
  const started = new Promise(resolve => {
    digestStarted = resolve
  })
  const gate = new Promise(resolve => {
    releaseDigest = resolve
  })
  crypto.subtle.digest = async function (...args) {
    digestStarted()
    await gate
    return originalDigest.apply(this, args)
  }
  try {
    const pending = requestLedgerSignature(request, {
      scope,
      summary,
      expiresAt: Date.now() + 5_000,
      payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
      validate: async () => {},
      signal: controller.signal
    })
    await started
    controller.abort(new Error('Late abort'))
    releaseDigest()
    await assert.rejects(pending, /Late abort/)
    assert.equal(tabs.length, 0)
    assert.equal(records.size, 0)
  } finally {
    crypto.subtle.digest = originalDigest
    releaseDigest?.()
  }
})

it('settles cancelled and submitted requests when session record deletion fails', async () => {
  const cancelled = await begin()
  failRemoval = true
  for (const listener of removedListeners) listener(cancelled.record.tabId)
  await assert.rejects(cancelled.promise, /tab was closed/)

  failRemoval = false
  const submitted = await begin()
  failRemoval = true
  await assert.rejects(
    submitLedgerSigningResponse(
      submitted.record.requestId,
      { signatureHex: 'signature' },
      submitted.record.tabId
    ),
    /state could not be cleared/
  )
  await assert.rejects(submitted.promise, /state could not be cleared/)
})

it('fails closed after service-worker module reload and clears its stale session record', async () => {
  const active = await begin()
  const restarted = await import(
    `../../../src/background/ledger-signing-coordinator.ts?restart=${Date.now()}`
  )
  await assert.rejects(
    restarted.getLedgerSigningRequest(active.record.requestId, active.record.tabId),
    /interrupted/
  )
  assert.equal(records.size, 0)
  await cancelAllLedgerSigning('Service worker restarted')
  await assert.rejects(active.promise, /Service worker restarted/)
})
