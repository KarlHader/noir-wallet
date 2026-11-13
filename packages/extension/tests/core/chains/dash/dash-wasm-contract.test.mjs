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
const PUBLIC_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSWORD = 'dash-wasm-contract'
const MESSAGE = new TextEncoder().encode('Dash')
const IMPORTED_KEY = '01'.repeat(32)
const BIP44_PSBT =
  'cHNidP8BAHcDAAAAAfXobue1upzNFDG7Nxozu6RZ6kKLinTXzD7DKeCjOfATAAAAAAD/////ApBfAQAAAAAAGXapFDgcLhGfIzgppPx7ZY4R4saJm7tEiKwoIwAAAAAAABl2qRSG1ES1GzcqSPFJt7h+lMx41uDp5IisAAAAAAABAFUDAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/////wD/////AaCGAQAAAAAAGXapFIpPWMIizVVExSe8ZpJWUrqnC16AiKwAAAAAIgYCb6mm8hO2uoZEeWX2tIISZKqt11IfBJ8A25xDp3DqdAUYc8XaCiwAAIAFAACAAAAAgAAAAAAAAAAAAAAiAgJSIeGojLAQYsXFhhQi84dGXf5XaNKK34y3WRtkFGiLXxhzxdoKLAAAgAUAAIAAAACAAQAAAAEAAAAA'

const MNEMONIC_ACCOUNT = {
  accountId: 'bip122:00000ffd590b1485b3caadc19b22e637:XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5',
  address: 'XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5',
  derivationPath: "m/44'/5'/0'/0/0",
  publicKey: '0x026fa9a6f213b6ba86447965f6b4821264aaadd7521f049f00db9c43a770ea7405',
  curve: 'secp256k1',
  addressScheme: 'dash_p2pkh',
  derivationScheme: 'bip44',
  network: 'mainnet',
  masterFingerprint: '0x73c5da0a',
  scriptPubKey: '0x76a9148a4f58c222cd5544c527bc66925652baa70b5e8088ac'
}

test.before(async () => {
  const bytes = readFileSync(path.join(packageDir, 'wallet_wasm_bg.wasm'))
  await init({ module_or_path: bytes })
})

test.describe('Dash WASM contract', () => {
  test('keeps Dash product capabilities separate from raw engine capabilities', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'wasm-integrity.json'), 'utf8'))
    const info = new WalletEngine().coreInfo()

    expect(info).toMatchObject({
      apiVersion: 10,
      vaultVersions: [1, 2]
    })
    expect(info.capabilities).toEqual(
      expect.arrayContaining([
        'dash_bip44',
        'dash_psbt',
        'dash_message',
        'dash_mainnet',
        'dash_testnet',
        'private_key_vault_dash',
        'dashCoinJoin',
        'starknet_mainnet',
        'pearl_psbt',
        'quantus_mainnet'
      ])
    )
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        'account.dash.derive',
        'account.dash.batch-derive',
        'account.dash.imported',
        'dash.psbt-v0.sign',
        'dash.message.sign',
        'dash.message.verify',
        'credential.import-private-key-dash',
        'account.pearl.derive',
        'account.pearl.batch-derive',
        'account.pearl.imported',
        'pearl.psbt-v0.sign',
        'pearl.bip322.sign',
        'pearl.bip322.verify',
        'credential.import-private-key-pearl'
      ])
    )
    for (const rawCapability of info.capabilities) {
      expect(manifest.capabilities).not.toContain(rawCapability)
    }
    expect(manifest.capabilities.join('\n')).not.toMatch(/strk20|coinjoin/i)
  })

  test('returns the engine account, PSBT, and message objects for the public mnemonic', () => {
    const engine = new WalletEngine()
    const vault = engine.importWallet(PUBLIC_MNEMONIC, PASSWORD, '')
    expectVault(vault)
    expect(engine.unlock(vault, PASSWORD)).toEqual({ sessionId: 1, kind: 'mnemonic' })

    expect(engine.deriveDashAccount(1, DASH_MAINNET, 0, false, 0)).toEqual(MNEMONIC_ACCOUNT)
    expect(engine.deriveDashAccounts(1, DASH_MAINNET, 0, false, 0, 2)).toEqual([
      MNEMONIC_ACCOUNT,
      {
        accountId: 'bip122:00000ffd590b1485b3caadc19b22e637:XbctnEsgWTn5j1co3emZynemxSFPqkLRKZ',
        address: 'XbctnEsgWTn5j1co3emZynemxSFPqkLRKZ',
        derivationPath: "m/44'/5'/0'/0/1",
        publicKey: '0x038f34569f115a9b6d5f4dc7d1150b396e2413b904c68a64d918ba54f37da38f22',
        curve: 'secp256k1',
        addressScheme: 'dash_p2pkh',
        derivationScheme: 'bip44',
        network: 'mainnet',
        masterFingerprint: '0x73c5da0a',
        scriptPubKey: '0x76a9140a38ec3f3cc4c169c295ddb037c31c63bf2fa39188ac'
      }
    ])

    expect(engine.prepareDashPsbt(1, DASH_MAINNET, 0, BIP44_PSBT)).toEqual({
      requestId: 1,
      summary: {
        chainId: DASH_MAINNET,
        network: 'mainnet',
        accountIndex: 0,
        psbtVersion: 0,
        unsignedTxid: 'ef065f30c6b88bd43b41b9b468ed59902a973d4df220d5d6b42e5f8865e84c76',
        transactionVersion: 3,
        transactionType: 0,
        lockTime: 0,
        inputCount: 1,
        outputCount: 2,
        signableInputCount: 1,
        totalInputDuffs: '100000',
        totalOutputDuffs: '99000',
        feeDuffs: '1000',
        inputs: [
          {
            index: 0,
            txid: '13f039a3e029c33eccd7748a8b42ea59a4bb331a37bb3114cd9cbab5e76ee8f5',
            vout: 0,
            sequence: 4294967295,
            valueDuffs: '100000',
            address: MNEMONIC_ACCOUNT.address,
            scriptPubKey: MNEMONIC_ACCOUNT.scriptPubKey,
            walletOwned: true,
            derivationPath: MNEMONIC_ACCOUNT.derivationPath,
            sighashType: 'SIGHASH_ALL'
          }
        ],
        outputs: [
          {
            index: 0,
            valueDuffs: '90000',
            address: 'XfoXRyRePBFFhg7fKbsGRQBixHipJSGqNf',
            scriptPubKey: '0x76a914381c2e119f233829a4fc7b658e11e2c6899bbb4488ac',
            walletOwned: false,
            isChange: false,
            derivationPath: null
          },
          {
            index: 1,
            valueDuffs: '9000',
            address: 'XnykfdCWrHENs8aH8X59RLZAn15VAP1cPB',
            scriptPubKey: '0x76a91486d444b51b372a48f149b7b87e94cc78d6e0e9e488ac',
            walletOwned: true,
            isChange: true,
            derivationPath: "m/44'/5'/0'/1/1"
          }
        ]
      }
    })
    expect(engine.confirmDashPsbt(1, 1)).toEqual({
      psbt: 'cHNidP8BAHcDAAAAAfXobue1upzNFDG7Nxozu6RZ6kKLinTXzD7DKeCjOfATAAAAAAD/////ApBfAQAAAAAAGXapFDgcLhGfIzgppPx7ZY4R4saJm7tEiKwoIwAAAAAAABl2qRSG1ES1GzcqSPFJt7h+lMx41uDp5IisAAAAAAABAFUDAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/////wD/////AaCGAQAAAAAAGXapFIpPWMIizVVExSe8ZpJWUrqnC16AiKwAAAAAIgICb6mm8hO2uoZEeWX2tIISZKqt11IfBJ8A25xDp3DqdAVHMEQCIA1XEptCITD78Caob7CAQyzl/FuO3kGA1IZ6D8of2PPSAiAkOQqy6HKtaiWl5h5VqyMg+dFppin1FFl9hulgDDnBRwEiBgJvqabyE7a6hkR5Zfa0ghJkqq3XUh8EnwDbnEOncOp0BRhzxdoKLAAAgAUAAIAAAACAAAAAAAAAAAAAACICAlIh4aiMsBBixcWGFCLzh0Zd/ldo0orfjLdZG2QUaItfGHPF2gosAACABQAAgAAAAIABAAAAAQAAAAA=',
      unsignedTxid: 'ef065f30c6b88bd43b41b9b468ed59902a973d4df220d5d6b42e5f8865e84c76',
      signedInputIndexes: [0]
    })

    expect(engine.prepareDashMessage(1, DASH_MAINNET, 0, false, 0, MESSAGE)).toEqual({
      requestId: 2,
      account: MNEMONIC_ACCOUNT,
      summary: {
        chainId: DASH_MAINNET,
        signer: MNEMONIC_ACCOUNT.address,
        messageHash: '0x50ff11c72e8a57ae936db6edd12a37455e31482b48caede31b53e5b2ac4840d2',
        byteLength: 4,
        utf8Preview: 'Dash',
        previewTruncated: false
      }
    })
    const signed = {
      signature:
        'IHhk3aBCkwlwP1a+SK42R5wcv/Z/auKUKUu7PAvySmSnZfqMN6nSfOrVuMVaaQg7Y7j3cSoXQ8zZEPL3zNiDh0I=',
      address: MNEMONIC_ACCOUNT.address,
      messageHash: '0x50ff11c72e8a57ae936db6edd12a37455e31482b48caede31b53e5b2ac4840d2'
    }
    expect(engine.confirmDashMessage(1, 2)).toEqual(signed)
    expect(
      engine.verifyDashMessage(DASH_MAINNET, signed.address, MESSAGE, signed.signature)
    ).toBe(true)
    expect(() =>
      engine.verifyDashMessage(
        DASH_MAINNET,
        signed.address,
        MESSAGE,
        signed.signature.replace('I', 'J')
      )
    ).toThrow(/invalid Dash message signature/)
  })

  test('returns the imported-key session and account without a kind field on the account', () => {
    const engine = new WalletEngine()
    const vault = engine.importPrivateKey(
      { privateKey: IMPORTED_KEY, chainFamily: 'dash', dashNetwork: 'mainnet' },
      PASSWORD
    )
    expectVault(vault)
    expect(engine.unlock(vault, PASSWORD)).toEqual({
      sessionId: 1,
      kind: 'private_key',
      chainFamily: 'dash',
      dashNetwork: 'mainnet'
    })

    const account = engine.deriveDashAccount(1, DASH_MAINNET, 0, false, 0)
    expect(account).toEqual({
      accountId: 'bip122:00000ffd590b1485b3caadc19b22e637:XmnGSJav3CWVmzDv5U68k7XT9rRPqyavtE',
      address: 'XmnGSJav3CWVmzDv5U68k7XT9rRPqyavtE',
      derivationPath: 'm',
      publicKey: '0x031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
      curve: 'secp256k1',
      addressScheme: 'dash_p2pkh',
      derivationScheme: 'imported',
      network: 'mainnet',
      masterFingerprint: '0x79b00088',
      scriptPubKey: '0x76a91479b000887626b294a914501a4cd226b58b23598388ac'
    })
    expect(account).not.toHaveProperty('kind')

    const prepared = engine.prepareDashMessage(1, DASH_MAINNET, 0, false, 0, MESSAGE)
    expect(prepared.account).toEqual(account)
    expect(prepared.summary).toEqual({
      chainId: DASH_MAINNET,
      signer: account.address,
      messageHash: '0x50ff11c72e8a57ae936db6edd12a37455e31482b48caede31b53e5b2ac4840d2',
      byteLength: 4,
      utf8Preview: 'Dash',
      previewTruncated: false
    })
    const signed = engine.confirmDashMessage(1, prepared.requestId)
    expect(signed).toEqual({
      signature:
        'IAXEd+O84ZeKOwOetiJZwEK2lomFBmZBIl7QDeeeeGX1bKcFqODsOn6usK7WOZyLVTJJd+kVFufKJUNr2RWbp7Y=',
      address: account.address,
      messageHash: prepared.summary.messageHash
    })
    expect(engine.verifyDashMessage(DASH_MAINNET, signed.address, MESSAGE, signed.signature)).toBe(
      true
    )
    expect(() => engine.prepareDashPsbt(1, DASH_MAINNET, 0, BIP44_PSBT)).toThrow(
      /Dash PSBT has no input owned by the imported key/
    )
  })
})

function expectVault(vault) {
  expect(vault).toMatchObject({
    version: 2,
    kdf: 'argon2id',
    cipher: 'xchacha20poly1305',
    kdfParams: { memoryKib: 65536, iterations: 3, parallelism: 1 }
  })
  expect(vault).not.toHaveProperty('kind')
  for (const field of ['salt', 'nonce', 'ciphertext']) {
    expect(typeof vault[field]).toBe('string')
    expect(vault[field].length).toBeGreaterThan(0)
  }
}
