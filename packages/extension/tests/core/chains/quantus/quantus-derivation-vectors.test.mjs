import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseRawQuantusAccount } from '../../../../src/infrastructure/keyring/multichain/raw-wallet-engine.ts'
import { toQuantusWasmChainId } from '../../../../src/core/chains/quantus/wasm-network.ts'

const PACKAGE_DIR = '../../../../src/infrastructure/generated/wasm/multichain'
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let enginePromise

async function packagedEngine() {
  enginePromise ??= (async () => {
    const module = await import(`${PACKAGE_DIR}/wallet_wasm.js`)
    const bytes = await readFile(new URL(`${PACKAGE_DIR}/wallet_wasm_bg.wasm`, import.meta.url))
    await module.default({ module_or_path: bytes })
    const engine = new module.WalletEngine()
    const vault = engine.importWallet(MNEMONIC, 'test-password', '')
    const { sessionId } = engine.unlock(vault, 'test-password')
    return { engine, sessionId }
  })()
  return enginePromise
}

test.describe('Packaged Quantus derivation contract', () => {
  test('derives the ML-DSA-87 account the host parser expects', async () => {
    const { engine, sessionId } = await packagedEngine()
    const raw = engine.deriveQuantusAccount(
      sessionId,
      toQuantusWasmChainId('quantus:mainnet'),
      'ml-dsa-87',
      0,
      false,
      0
    )
    expect(Object.keys(raw).sort()).toEqual([
      'accountId',
      'address',
      'addressScheme',
      'curve',
      'derivationPath',
      'derivationScheme',
      'network',
      'publicKey',
      'scheme'
    ])
    expect(raw).toMatchObject({
      address: 'qzna4bUiEiZdXQpwvSQDmM2y9rBPyJRS9iNm85jPgicM76kA8',
      // `curve` is snake_case while `scheme` is kebab-case.
      curve: 'ml_dsa87',
      scheme: 'ml-dsa-87',
      addressScheme: 'quantus',
      derivationScheme: 'bip44',
      derivationPath: "m/44'/189189'/0'/0'/0'",
      network: 'mainnet'
    })
    expect(raw.publicKey).toHaveLength(2 + 2592 * 2)
    expect(raw.accountId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(parseRawQuantusAccount(raw)).toMatchObject({ address: raw.address, scheme: 'ml-dsa-87' })
  })

  test('derives ML-DSA-65 with its own curve and key size', async () => {
    const { engine, sessionId } = await packagedEngine()
    const raw = parseRawQuantusAccount(
      engine.deriveQuantusAccount(
        sessionId,
        toQuantusWasmChainId('quantus:mainnet'),
        'ml-dsa-65',
        0,
        false,
        0
      )
    )
    expect(raw).toMatchObject({
      address: 'qzk6rxHFKng79JR8KnadbPUPMhJqzre1SegC45mFnN25ZRSBF',
      curve: 'ml_dsa65',
      scheme: 'ml-dsa-65'
    })
    expect(raw.publicKey).toHaveLength(2 + 1952 * 2)
  })

  test('batch derivation keeps the address index inside the hardened path', async () => {
    const { engine, sessionId } = await packagedEngine()
    const accounts = engine
      .deriveQuantusAccounts(
        sessionId,
        toQuantusWasmChainId('quantus:mainnet'),
        'ml-dsa-87',
        0,
        false,
        0,
        2
      )
      .map(parseRawQuantusAccount)
    expect(accounts.map(account => account.derivationPath)).toEqual([
      "m/44'/189189'/0'/0'/0'",
      "m/44'/189189'/0'/0'/1'"
    ])
    expect(accounts[1].address).toBe('qznFDa1qesTQ5UzEjGV4SDZTJJkqVmiqXUxkm9gMPU3JsuFFh')
  })

  test('accepts the Planck identifier and the host dev mapping', async () => {
    const { engine, sessionId } = await packagedEngine()
    const planck = engine.deriveQuantusAccount(
      sessionId,
      'quantus:planck',
      'ml-dsa-87',
      0,
      false,
      0
    )
    expect(planck).toMatchObject({ network: 'planck' })

    // Derivation is independent of the network reference: only the `network`
    // label differs, so the host can still map Planck onto `quantus:dev`.
    const mainnet = engine.deriveQuantusAccount(
      sessionId,
      toQuantusWasmChainId('quantus:mainnet'),
      'ml-dsa-87',
      0,
      false,
      0
    )
    const testnet = engine.deriveQuantusAccount(
      sessionId,
      toQuantusWasmChainId('quantus:planck'),
      'ml-dsa-87',
      0,
      false,
      0
    )
    expect(testnet).toMatchObject({ network: 'dev' })
    expect(planck.address).toBe(mainnet.address)
    expect(planck.publicKey).toBe(mainnet.publicKey)
    expect(planck.derivationPath).toBe(mainnet.derivationPath)
    expect(testnet.address).toBe(mainnet.address)
    expect(testnet.accountId).toBe(mainnet.accountId)
    expect(testnet.publicKey).toBe(mainnet.publicKey)
    expect(testnet.derivationPath).toBe(mainnet.derivationPath)
  })
})
