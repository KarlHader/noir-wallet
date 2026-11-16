import { test } from 'node:test'
import { expect } from '@playwright/test'
import { createPublicKey } from 'node:crypto'
import {
  DEVELOPMENT_EXTENSION_PUBLIC_KEY,
  resolveDevelopmentExtensionKey
} from '../../../scripts/lib/extension-build-config.ts'

test.describe('development extension identity', () => {
  test('uses one valid fixed public key for the local dev server', () => {
    expect(resolveDevelopmentExtensionKey({ EXTENSION_DEV_SERVER: '1' })).toBe(
      DEVELOPMENT_EXTENSION_PUBLIC_KEY
    )

    const publicKey = createPublicKey({
      key: Buffer.from(DEVELOPMENT_EXTENSION_PUBLIC_KEY, 'base64'),
      format: 'der',
      type: 'spki'
    })
    expect(publicKey.asymmetricKeyType).toBe('rsa')
  })

  test('does not pin non-dev-server extension builds', () => {
    expect(resolveDevelopmentExtensionKey({})).toBeUndefined()
    expect(resolveDevelopmentExtensionKey({ BUILD_CHANNEL: 'beta' })).toBeUndefined()
    expect(resolveDevelopmentExtensionKey({ BUILD_CHANNEL: 'production' })).toBeUndefined()
    expect(
      resolveDevelopmentExtensionKey({ PLAYWRIGHT_E2E: '1', BUILD_CHANNEL: 'development' })
    ).toBeUndefined()
  })

  test('rejects a release channel combined with the dev server', () => {
    expect(() =>
      resolveDevelopmentExtensionKey({ EXTENSION_DEV_SERVER: '1', BUILD_CHANNEL: 'beta' })
    ).toThrow('EXTENSION_DEV_SERVER requires BUILD_CHANNEL=development')
    expect(() =>
      resolveDevelopmentExtensionKey({ EXTENSION_DEV_SERVER: '1', BUILD_CHANNEL: 'production' })
    ).toThrow('EXTENSION_DEV_SERVER requires BUILD_CHANNEL=development')
  })
})
