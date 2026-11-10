import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import init, { WalletEngine } from '../../../../src/infrastructure/generated/wasm/multichain/wallet_wasm.js'
import { detectPrivateKeyImport } from '../../../../src/core/keyring/application/private-key-import-detection.ts'

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/infrastructure/generated/wasm/multichain'
)
const DASH_MAINNET = 'bip122:00000ffd590b1485b3caadc19b22e637'
const DASH_TESTNET = 'bip122:00000bafbc94add76cb75e2ec9289483'
const PASSWORD = 'dash-private-key'
const COMPRESSED_MAINNET_WIF = 'XBKapk5oXFntVVxGHssjuaCvQYQ18KgWf68gsC2s2mVp5tquNQUf'
const UNCOMPRESSED_MAINNET_WIF = '7qZJdeQHtG8gJnXeT2ZLh1GqoZwbvKHChoUa3mBqwmyNYUPs3d9'
const COMPRESSED_TESTNET_WIF = 'cMceqPhHedrhbcR9eXgzmfWy7kRqLyAxMYwFT6ABDWsiwUp9Nsq9'
const BITCOIN_MAINNET_WIF = 'KwFfNUhSDaASSAwtG7ssQM1uVX8RgX5GHWnnLfhfiQDigjioWXHH'

test.before(async () => {
  const bytes = readFileSync(path.join(packageDir, 'wallet_wasm_bg.wasm'))
  await init({ module_or_path: bytes })
})

function importDash(privateKey, dashNetwork) {
  const engine = new WalletEngine()
  return engine.importPrivateKey({ privateKey, chainFamily: 'dash', dashNetwork }, PASSWORD)
}

test.describe('Dash private-key import', () => {
  test('keeps a compressed testnet WIF ambiguous between Bitcoin and Dash', () => {
    expect(detectPrivateKeyImport(COMPRESSED_TESTNET_WIF)).toEqual({
      chainFamily: null,
      format: 'ambiguous-testnet-wif',
      ambiguous: true,
      candidates: ['bip122', 'dash']
    })
    expect(detectPrivateKeyImport(COMPRESSED_MAINNET_WIF)).toEqual({
      chainFamily: 'dash',
      format: 'dash-wif',
      ambiguous: false
    })
    expect(detectPrivateKeyImport(BITCOIN_MAINNET_WIF).chainFamily).toBe('bip122')
    expect(detectPrivateKeyImport(UNCOMPRESSED_MAINNET_WIF)).toBeNull()
  })

  test('imports a 32-byte key only when dashNetwork is present', () => {
    const engine = new WalletEngine()
    const vault = importDash('01'.repeat(32), 'mainnet')
    engine.unlock(vault, PASSWORD)
    expect(engine.deriveDashAccount(1, DASH_MAINNET, 0, false, 0)).toMatchObject({
      address: 'XmnGSJav3CWVmzDv5U68k7XT9rRPqyavtE',
      derivationPath: 'm',
      derivationScheme: 'imported'
    })
    expect(() =>
      engine.importPrivateKey({ privateKey: '01'.repeat(32), chainFamily: 'dash' }, PASSWORD)
    ).toThrow(/dashNetwork is required/)
  })

  test('rejects the wrong network, uncompressed keys, and an illegal scalar', () => {
    expect(() => importDash(BITCOIN_MAINNET_WIF, 'mainnet')).toThrow(
      /compressed WIF or 32-byte hexadecimal/
    )
    expect(() => importDash(COMPRESSED_TESTNET_WIF, 'mainnet')).toThrow(/network does not match/)
    expect(() => importDash(UNCOMPRESSED_MAINNET_WIF, 'mainnet')).toThrow(/uncompressed/)
    expect(() => importDash('00'.repeat(32), 'mainnet')).toThrow(/out of range/)
    expect(() => importDash('ff'.repeat(32), 'mainnet')).toThrow(/out of range/)
  })

  test('imports the shared testnet WIF only for an explicit Dash testnet choice', () => {
    const engine = new WalletEngine()
    const vault = importDash(COMPRESSED_TESTNET_WIF, 'testnet')
    engine.unlock(vault, PASSWORD)
    expect(engine.deriveDashAccount(1, DASH_TESTNET, 0, false, 0)).toMatchObject({
      address: 'yXQsTFfMUkAa7j9TeKQXn8woS8umNDzGPn',
      derivationPath: 'm',
      derivationScheme: 'imported',
      network: 'testnet'
    })
    expect(() => engine.deriveDashAccount(1, DASH_TESTNET, 0, false, 1)).toThrow(
      /addressIndex=0/
    )
    expect(() => engine.deriveDashAccounts(1, DASH_TESTNET, 0, false, 0, 2)).toThrow(
      /batch count 1/
    )
  })

  test('rejects an account index outside the BIP32 range', () => {
    const engine = new WalletEngine()
    const vault = engine.importWallet(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      PASSWORD,
      ''
    )
    engine.unlock(vault, PASSWORD)
    expect(() => engine.deriveDashAccount(1, DASH_MAINNET, 2_147_483_648, false, 0)).toThrow(
      /2\^31|below 2\^31/
    )
  })
})
