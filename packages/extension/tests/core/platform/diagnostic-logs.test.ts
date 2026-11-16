import { test } from 'node:test'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
import {
  DIAGNOSTIC_LOG_MAX_AGE_MS,
  DIAGNOSTIC_LOG_MAX_ENTRY_BYTES,
  retainDiagnosticEntries,
  serializeDiagnosticArgs,
  type DiagnosticLogEntry
} from '../../../src/lib/diagnostic-log'
import { parseTrustedExtensionRuntimeMessage } from '../../../src/lib/runtime-message-security'
import {
  formatHardwareSigningError,
  isHardwareDeviceSelectionCancelled
} from '../../../src/lib/hardware-signing-error'
const { DeviceExchangeError, NoAccessibleDeviceError, OpeningConnectionError } = createRequire(
  import.meta.url
)('@ledgerhq/device-management-kit')

test('hardware diagnostics retain vendor error reasons without leaking signed payloads', () => {
  const encoded = 'cGN6dA'.repeat(40)
  const bytes = `[${Array.from({ length: 64 }, (_, i) => i).join(', ')}]`
  const address = `u1${'a'.repeat(70)}`
  const failure = Object.assign(
    new Error(
      `Failed to combine PCZT: SignatureMismatch ${encoded} ${bytes} address=${address} amount=1.25 ZEC`
    ),
    { statusCode: 0x6985 }
  )
  const message = formatHardwareSigningError(failure)
  expect(message).toContain('Failed to combine PCZT: SignatureMismatch')
  expect(message).toContain('statusCode=27013')
  for (const sensitive of [encoded, bytes, address, '1.25'])
    expect(message).not.toContain(sensitive)
  expect(formatHardwareSigningError('Failed to parse PCZT bytes: UnknownVersion(3)')).toBe(
    'Failed to parse PCZT bytes: UnknownVersion(3)'
  )
  // Use the installed SDK's non-Error wrappers, as returned by WebHID/BLE.
  const denied = new DOMException('Access denied to HID device', 'NotAllowedError')
  const wrapped = new NoAccessibleDeviceError(denied)
  const usbMessage = formatHardwareSigningError(wrapped)
  expect(usbMessage).toContain('NoAccessibleDeviceError')
  expect(usbMessage).toContain('NotAllowedError')
  expect(usbMessage).toContain('Access denied to HID device')
  expect(isHardwareDeviceSelectionCancelled(wrapped)).toBe(false)
  expect(
    isHardwareDeviceSelectionCancelled(new NoAccessibleDeviceError('No selected device'))
  ).toBe(true)
  expect(
    isHardwareDeviceSelectionCancelled(
      new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError')
    )
  ).toBe(true)
  expect(
    isHardwareDeviceSelectionCancelled(
      new DOMException('Bluetooth adapter not available', 'NotFoundError')
    )
  ).toBe(false)
  const deviceError = new DeviceExchangeError({
    tag: 'ZcashAppCommandError',
    errorCode: '6a80',
    originalError: failure
  })
  const connection = new OpeningConnectionError(
    new Error('HID connection failed', { cause: deviceError })
  )
  const connectionMessage = formatHardwareSigningError(connection)
  expect(connectionMessage).toContain('ConnectionOpeningError')
  expect(connectionMessage).toContain('ZcashAppCommandError')
  expect(connectionMessage).toContain('errorCode=6a80')
  expect(connectionMessage).toContain('SignatureMismatch')
  for (const sensitive of [encoded, bytes, address, '1.25'])
    expect(connectionMessage).not.toContain(sensitive)
  Object.assign(connection, { err: connection })
  expect(formatHardwareSigningError(connection)).toContain('Circular error')
})

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
