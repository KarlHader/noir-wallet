import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  DIAGNOSTIC_LOG_MAX_AGE_MS,
  DIAGNOSTIC_LOG_MAX_ENTRY_BYTES,
  retainDiagnosticEntries,
  serializeDiagnosticArgs,
  type DiagnosticLogEntry
} from '../../../src/lib/diagnostic-log'
import { parseTrustedExtensionRuntimeMessage } from '../../../src/lib/runtime-message-security'

function makeEntry(id: number, timestamp: number, byteSize = 100): DiagnosticLogEntry {
  return {
    id,
    source: 'background',
    level: 'info',
    message: `entry-${id}`,
    timestamp,
    sequence: id,
    byteSize
  }
}

test('diagnostic serialization removes wallet secrets, identifiers, URLs, and amounts', () => {
  const address = `u1${'a'.repeat(70)}`
  const solanaAddress = '1'.repeat(32)
  const bitcoinAddress = `bc1q${'a'.repeat(35)}`
  const rawBinary = new Uint8Array([11, 22, 33, 44])
  const serialized = serializeDiagnosticArgs([
    {
      password: 'never-store-this-password',
      seedPhrase: 'never store this recovery phrase',
      privateKey: 'never-store-this-key',
      address,
      amount: '12.34',
      rawBinary,
      jsonDetails: `{"privateKey":"json-private-key","address":"${address}","amount":9.75}`,
      chainAddresses: `${solanaAddress} ${bitcoinAddress}`,
      message: `balance=1.25 sent to ${address} at https://private.example/path`
    }
  ])

  for (const value of [
    'never-store-this-password',
    'never store this recovery phrase',
    'never-store-this-key',
    'json-private-key',
    address,
    solanaAddress,
    bitcoinAddress,
    '12.34',
    '1.25',
    '9.75',
    'private.example'
  ]) {
    expect(serialized).not.toContain(value)
  }
  expect(serialized).toContain('[Redacted]')
  expect(serialized).toContain('[Redacted address]')
  expect(serialized).toContain('[Uint8Array:4 bytes]')
  expect(serialized).not.toContain('11,22,33,44')
  expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
    DIAGNOSTIC_LOG_MAX_ENTRY_BYTES
  )
})

test('diagnostic retention keeps only recent entries within count and byte bounds', () => {
  const now = 10_000_000
  const entries = [
    makeEntry(1, now - DIAGNOSTIC_LOG_MAX_AGE_MS - 1),
    ...Array.from({ length: 510 }, (_, index) => makeEntry(index + 2, now - 1_000 + index, 1_200))
  ]
  const retained = retainDiagnosticEntries(entries, now)

  expect(retained.some(entry => entry.id === 1)).toBe(false)
  expect(retained.length).toBeLessThanOrEqual(500)
  expect(retained.reduce((total, entry) => total + entry.byteSize, 0)).toBeLessThanOrEqual(
    512 * 1024
  )
  expect(retained.at(-1)?.id).toBe(511)
})

test('diagnostic runtime messages accept bounded drafts and reject extra payload fields', () => {
  const entry = {
    source: 'popup',
    level: 'warn',
    message: 'An operation failed',
    timestamp: Date.now(),
    sequence: 0
  }

  expect(
    parseTrustedExtensionRuntimeMessage({ type: 'APPEND_DIAGNOSTIC_LOG', entry })
  ).toMatchObject({
    type: 'APPEND_DIAGNOSTIC_LOG',
    entry
  })
  expect(() =>
    parseTrustedExtensionRuntimeMessage({
      type: 'APPEND_DIAGNOSTIC_LOG',
      entry: { ...entry, password: 'not allowed' }
    })
  ).toThrow()
  expect(parseTrustedExtensionRuntimeMessage({ type: 'EXPORT_DIAGNOSTIC_LOGS' })).toEqual({
    type: 'EXPORT_DIAGNOSTIC_LOGS'
  })
})
