import { test } from 'node:test'
import { expect } from '@playwright/test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const sourceRoot = fileURLToPath(new URL('../../../../src', import.meta.url))

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

test.describe('Background Zcash wallet runtime boundary', () => {
  test('removes the legacy runtime file and singleton names from extension source', () => {
    const legacyFileName = ['account', 'manager.ts'].join('-')
    const legacyClassName = ['Account', 'Manager'].join('')
    const legacySingletonName = ['account', 'Manager'].join('')

    expect(existsSync(join(sourceRoot, 'core/wallet', legacyFileName))).toBe(false)
    for (const path of sourceFiles(sourceRoot)) {
      const source = readFileSync(path, 'utf8')
      expect(source, path).not.toContain(legacyClassName)
      expect(source, path).not.toContain(legacySingletonName)
    }
  })

  test('keeps the owning runtime in Background and exposes only trusted Popup messages', () => {
    const backgroundRuntime = readFileSync(
      join(sourceRoot, 'background/zcash-wallet-runtime.ts'),
      'utf8'
    )
    const background = readFileSync(join(sourceRoot, 'background/index.ts'), 'utf8')
    const client = readFileSync(
      join(sourceRoot, 'popup/services/zcash-wallet-runtime-client.ts'),
      'utf8'
    )

    expect(backgroundRuntime).toContain('export class BackgroundZcashWalletRuntime')
    expect(backgroundRuntime).toContain('export const backgroundZcashWalletRuntime')
    expect(backgroundRuntime).toContain('onSyncRequested: (() => void) | null')
    expect(backgroundRuntime).not.toContain("type: 'ADD_ACCOUNT'")
    expect(backgroundRuntime).not.toContain("type: 'SWITCH_ACCOUNT'")
    expect(backgroundRuntime).not.toContain("type: 'CHANGE_WALLET_PASSWORD'")
    expect(background).toContain("message.type === 'ESTIMATE_ZCASH_MAX_TRANSFER'")
    expect(background).toContain("message.type === 'ROTATE_ZCASH_SHIELDED_ADDRESS'")
    expect(client).toContain("type: 'PROVISION_PRIMARY_SOFTWARE_WALLET'")
    expect(client).toContain("type: 'GET_ZCASH_SEED_PHRASE'")

    for (const relativeDirectory of ['popup', 'store']) {
      for (const path of sourceFiles(join(sourceRoot, relativeDirectory))) {
        expect(readFileSync(path, 'utf8'), path).not.toContain('background/zcash-wallet-runtime')
      }
    }
  })
})
