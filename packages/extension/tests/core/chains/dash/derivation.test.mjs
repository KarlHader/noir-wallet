import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import init, { WalletEngine } from '../../../../src/infrastructure/generated/wasm/multichain/wallet_wasm.js'

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/infrastructure/generated/wasm/multichain'
)
const DASH_MAINNET = 'bip122:00000ffd590b1485b3caadc19b22e637'
const DASH_TESTNET = 'bip122:00000bafbc94add76cb75e2ec9289483'
const PUBLIC_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSWORD = 'dash-derivation'
const MAX_BIP32_INDEX = 2_147_483_647

test.before(async () => {
  const bytes = readFileSync(path.join(packageDir, 'wallet_wasm_bg.wasm'))
  await init({ module_or_path: bytes })
})

function unlockMnemonic() {
  const engine = new WalletEngine()
  const vault = engine.importWallet(PUBLIC_MNEMONIC, PASSWORD, '')
  engine.unlock(vault, PASSWORD)
  return engine
}

test.describe('Dash derivation', () => {
  test('derives the public mnemonic at m/44\'/5\'/0\'/0/0 on mainnet', () => {
    const engine = unlockMnemonic()
    const account = engine.deriveDashAccount(1, DASH_MAINNET, 0, false, 0)
    expect(account).not.toHaveProperty('kind')
    expect(account).toMatchObject({
      address: 'XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5',
      derivationPath: "m/44'/5'/0'/0/0",
      addressScheme: 'dash_p2pkh',
      derivationScheme: 'bip44',
      network: 'mainnet',
      curve: 'secp256k1'
    })
  })

  test('derives the public mnemonic at m/44\'/1\'/0\'/0/0 on testnet', () => {
    const engine = unlockMnemonic()
    const account = engine.deriveDashAccount(1, DASH_TESTNET, 0, false, 0)
    expect(account).toMatchObject({
      address: 'yRd4FhXfVGHXpsuZXPNkMrfD9GVj46pnjt',
      derivationPath: "m/44'/1'/0'/0/0",
      addressScheme: 'dash_p2pkh',
      derivationScheme: 'bip44',
      network: 'testnet'
    })
    expect(account).not.toHaveProperty('kind')
  })

  test('accepts the last BIP32 account index and rejects the next one', () => {
    const engine = unlockMnemonic()
    const account = engine.deriveDashAccount(1, DASH_MAINNET, MAX_BIP32_INDEX, false, 0)
    expect(account.derivationPath).toBe(`m/44'/5'/${MAX_BIP32_INDEX}'/0/0`)
    expect(account.addressScheme).toBe('dash_p2pkh')
    expect(() => engine.deriveDashAccount(1, DASH_MAINNET, MAX_BIP32_INDEX + 1, false, 0)).toThrow(
      /2\^31|below 2\^31/
    )
  })

  test('does not scan an imported key as an HD chain', () => {
    const engine = new WalletEngine()
    const vault = engine.importPrivateKey(
      { privateKey: '01'.repeat(32), chainFamily: 'dash', dashNetwork: 'mainnet' },
      PASSWORD
    )
    engine.unlock(vault, PASSWORD)
    const account = engine.deriveDashAccount(1, DASH_MAINNET, 0, false, 0)
    expect(account).toMatchObject({
      address: 'XmnGSJav3CWVmzDv5U68k7XT9rRPqyavtE',
      derivationPath: 'm',
      derivationScheme: 'imported',
      addressScheme: 'dash_p2pkh'
    })
    expect(() => engine.deriveDashAccount(1, DASH_MAINNET, 0, false, 1)).toThrow(
      /accountIndex=0, change=false, and addressIndex=0/
    )
    expect(() => engine.deriveDashAccounts(1, DASH_MAINNET, 0, false, 0, 2)).toThrow(
      /batch count 1/
    )
  })
})
