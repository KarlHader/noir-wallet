import { expect, test } from '@playwright/test'
import { getZnsClient } from '../../../src/lib/zns'

test.describe('ZNS SDK Integration', () => {
  test.skip(
    process.env.LIVE_INTEGRATION !== '1',
    'Set LIVE_INTEGRATION=1 to run tests against public ZNS services'
  )

  test('testnet client connects and reports status', async () => {
    const zns = getZnsClient('testnet')
    const status = await zns.status()

    expect(status).toBeTruthy()
    expect(status.adminPubkey).toBeTruthy()
    expect(typeof status.syncedHeight).toBe('number')
    expect(status.syncedHeight).toBeGreaterThan(0)
    expect(typeof status.registered).toBe('number')
  })

  test('mainnet client connects and reports status', async () => {
    const zns = getZnsClient('mainnet')
    const status = await zns.status()

    expect(status).toBeTruthy()
    expect(status.adminPubkey).toBeTruthy()
    expect(typeof status.syncedHeight).toBe('number')
  })

  test('resolveName aliases return the same address for a known name (testnet)', async () => {
    const zns = getZnsClient('testnet')

    // "zechariah" is a known testnet registration
    const resolved = await Promise.all(
      ['ZECHARIAH', 'ZECHARIAH.ZEC', 'ZECHARIAH.ZCASH'].map(name => zns.resolveName(name))
    )

    for (const registration of resolved) {
      expect(registration).toBeTruthy()
      expect(registration!.name).toBe('zechariah')
      expect(registration!.address.startsWith('utest1')).toBeTruthy()
      expect(registration!.address).toBe(resolved[0]!.address)
    }
  })

  test('resolveName returns null for non-existent name', async () => {
    const zns = getZnsClient('testnet')
    const resolved = await zns.resolveName('this_name_definitely_does_not_exist_xyz_123456')

    expect(resolved).toBeNull()
  })

  test('isValidName validates correctly', async () => {
    const zns = getZnsClient('testnet')

    expect(zns.isValidName('alice')).toBe(true)
    expect(zns.isValidName('bob123')).toBe(true)
    expect(zns.isValidName('Alice')).toBe(false)
    expect(zns.isValidName('')).toBe(false)
  })

  test('isAvailable returns boolean', async () => {
    const zns = getZnsClient('testnet')
    const result = await zns.isAvailable('xyzabc99')

    expect(typeof result).toBe('boolean')
  })
})
