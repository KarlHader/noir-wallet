import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  loadLocalTestWalletEnvironment,
  parseTestWalletEnvironment
} from '../../../scripts/lib/test-wallet-env.mjs'

test.describe('local test-wallet environment', () => {
  const temporaryDirectories = []

  test.afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true }))
    )
  })

  test('loads only approved non-secret metadata without overriding explicit values', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'noir-test-wallet-env-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, '.env.test-wallets.local')
    await writeFile(
      filePath,
      [
        '# local registry',
        'NOIR_BITCOIN_TESTNET_WALLET_FILE=/private/bitcoin-testnet3.json',
        'NOIR_EVM_TESTNET_WALLET_FILE="/private/path with spaces/evm.json"',
        'NOIR_TESTNET_ACCOUNT=2',
        'TESTNET_1_BLOCK=3000000'
      ].join('\n'),
      { mode: 0o600 }
    )
    await chmod(filePath, 0o600)
    const environment = { NOIR_TESTNET_ACCOUNT: '1' }

    const result = loadLocalTestWalletEnvironment({ environment, filePath })

    expect(result.loaded).toBe(true)
    expect(result.loadedKeys).toEqual([
      'NOIR_BITCOIN_TESTNET_WALLET_FILE',
      'NOIR_EVM_TESTNET_WALLET_FILE',
      'TESTNET_1_BLOCK'
    ])
    expect(environment).toEqual({
      NOIR_BITCOIN_TESTNET_WALLET_FILE: '/private/bitcoin-testnet3.json',
      NOIR_EVM_TESTNET_WALLET_FILE: '/private/path with spaces/evm.json',
      NOIR_TESTNET_ACCOUNT: '1',
      TESTNET_1_BLOCK: '3000000'
    })
  })

  test('rejects secrets and broadcast switches in the local registry', () => {
    expect(() => parseTestWalletEnvironment('NOIR_TESTNET_MNEMONIC=secret words')).toThrow(
      /Unsupported test-wallet variable/
    )
    expect(() => parseTestWalletEnvironment('NOIR_TESTNET_BROADCAST=1')).toThrow(
      /Unsupported test-wallet variable/
    )
  })

  test('rejects a registry readable by other users', async context => {
    if (process.platform === 'win32') {
      context.skip('POSIX permission bits are not available')
      return
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'noir-test-wallet-env-mode-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, '.env.test-wallets.local')
    await writeFile(filePath, 'NOIR_TESTNET_ACCOUNT=1\n', { mode: 0o644 })
    await chmod(filePath, 0o644)

    expect(() => loadLocalTestWalletEnvironment({ environment: {}, filePath })).toThrow(
      /must use mode 0600/
    )
  })
})
