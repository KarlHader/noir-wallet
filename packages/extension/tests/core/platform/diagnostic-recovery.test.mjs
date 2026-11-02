import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getDiagnosticErrorDetails,
  sanitizeDiagnosticMessage,
  serializeDiagnosticArgs
} from '../../../src/lib/diagnostic-log.ts'
import { parseTrustedExtensionRuntimeMessage } from '../../../src/lib/runtime-message-security.ts'

test('diagnostic runtime drafts accept legacy and anonymous context formats, rejecting identifying contexts', () => {
  const entry = { source: 'worker', level: 'error', message: 'failed', timestamp: 1, sequence: 0 }
  for (const draft of [entry, { ...entry, contextId: '12345678-1234-1234-1234-123456789012' }]) {
    assert.deepEqual(
      parseTrustedExtensionRuntimeMessage({ type: 'APPEND_DIAGNOSTIC_LOG', entry: draft }).entry,
      draft
    )
  }
  for (const draft of [
    { ...entry, contextId: 'private-wallet-name' },
    { ...entry, password: 'secret' }
  ]) {
    assert.throws(() =>
      parseTrustedExtensionRuntimeMessage({ type: 'APPEND_DIAGNOSTIC_LOG', entry: draft })
    )
  }
})

test('diagnostics redact embedded recovery phrases and encoded credentials', () => {
  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const log = serializeDiagnosticArgs([
    `operation failed with input (${phrase}); retry needed`,
    {
      ufvk: 'private-viewing-material',
      ciphertext: 'encrypted-secret',
      keyMaterial: 'session-key'
    },
    'authorization: Bearer private.bearer.token'
  ])
  for (const value of [
    phrase,
    'private-viewing-material',
    'encrypted-secret',
    'session-key',
    'private.bearer.token'
  ]) {
    assert.ok(!log.includes(value))
  }
  assert.match(log, /operation failed/)
  assert.match(log, /Recovery phrase redacted/)
})

test('diagnostics retain safe error chains without running custom getters', () => {
  const inner = new Error('Missing chunk 1/2 for key: mainnet_wallet')
  inner.code = 'SNAPSHOT_FAILURE'
  const outer = new Error('Send preparation failed', { cause: inner })
  let reads = 0
  Object.defineProperty(outer, 'details', {
    get() {
      reads++
      throw Error('unsafe')
    }
  })
  const details = getDiagnosticErrorDetails(outer)
  assert.equal(details.cause.code, 'SNAPSHOT_FAILURE')
  const log = serializeDiagnosticArgs([outer])
  assert.equal(reads, 0)
  assert.match(log, /Send preparation failed/)
  assert.match(log, /Missing chunk 1\/2/)
  assert.match(log, /SNAPSHOT_FAILURE/)
  inner.cause = outer
  assert.doesNotThrow(() => serializeDiagnosticArgs([outer]))
})

test('diagnostics redact every Zcash pool in new and previously persisted messages', () => {
  const message = 'WASM summary: sapling=111, orchard=222, ironwood=333, unshielded=444'
  for (const safe of [serializeDiagnosticArgs([message]), sanitizeDiagnosticMessage(message)]) {
    for (const pool of ['sapling', 'orchard', 'ironwood', 'unshielded']) {
      assert.match(safe, new RegExp(`${pool}=\\[Redacted\\]`))
    }
    assert.match(safe, /WASM summary/)
  }
})

test('identifier redaction remains stable through repeated forwarding and export', () => {
  const message =
    'walletId=synthetic-wallet accountId="synthetic-account" origin=https://example.test'
  const safe = sanitizeDiagnosticMessage(message)
  assert.equal(
    safe,
    'walletId=[Redacted identifier] accountId=[Redacted identifier] origin=[Redacted identifier]'
  )
  let forwarded = safe
  for (let pass = 0; pass < 5; pass += 1) {
    forwarded = sanitizeDiagnosticMessage(serializeDiagnosticArgs([forwarded]))
    assert.equal(forwarded, safe)
  }
  assert.equal(
    sanitizeDiagnosticMessage(`${safe}; transactionId=new-private-identifier`),
    `${safe}; transactionId=[Redacted identifier]`
  )
})
