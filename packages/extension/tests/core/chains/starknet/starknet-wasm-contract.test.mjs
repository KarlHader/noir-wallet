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
const MNEMONIC = 'test test test test test test test test test test test junk'
const PASSWORD = 'starknet-wasm-contract'
const CHAIN = 'starknet:SN_MAIN'
const CLASS_HASH = '0x05b4b537eaa2399e3aa99c4e2e0208ebd6c71bc1467938cd52c798c601e43564'
const PUBLIC_KEY = '0x7f0ecd1ec6159e6a7c70084aaa7d693d9113149b80ab72618602a185e2c1f2b'
const OZ_ADDRESS = '0x58ac366fa8dc98e25a85c7343bcca64324c2e7e65c017785c363d1066ce072a'
const ARGENT_V0_4_ADDRESS = '0x6a62e3abc08f1190cf071afeec31d1693f71c9f126e820b98d7017f133e6a27'
const INVOKE_HASH = '0x47925e9fbb257d423cff737a67c87d38c652eba94ab17d6647d27b8df4f48ff'
const DEPLOY_HASH = '0x668af19c699dc83d7f8fd6b76192c761bc8644881ab6c5ec2e0b0fd119726dc'
const TYPED_DATA_HASH = '0x57121ba07e3bd1a309423d650316771d937af5554dc9320de99d5f41a133bc2'
const QUERY_VERSION = '0x100000000000000000000000000000003'
const RESOURCE_BOUNDS = {
  l1Gas: { maxAmount: '1000', maxPricePerUnit: '200000000000' },
  l2Gas: { maxAmount: '2000', maxPricePerUnit: '300000000000' },
  l1DataGas: { maxAmount: '3000', maxPricePerUnit: '400000000000' }
}
const VECTOR_CALL = {
  to: '0x049d36570d4e46f48e99674bd3fcc84644dddf0d1b1e6a4b3f4b2f6f4f5a6b7c',
  selector: '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e',
  calldata: [
    '0x049d36570d4e46f48e99674bd3fcc84644dddf0d1b1e6a4b3f4b2f6f4f5a6b7c',
    '0x1234',
    '0x0'
  ]
}
const TYPED_DATA = JSON.stringify({
  types: {
    StarknetDomain: [
      { name: 'name', type: 'shortstring' },
      { name: 'version', type: 'shortstring' },
      { name: 'chainId', type: 'shortstring' },
      { name: 'revision', type: 'shortstring' }
    ],
    Message: [{ name: 'content', type: 'felt' }]
  },
  primaryType: 'Message',
  domain: { name: 'MyDapp', version: '1', chainId: 'SN_MAIN', revision: '1' },
  message: { content: '0x1234' }
})

test.before(async () => {
  const bytes = readFileSync(path.join(packageDir, 'wallet_wasm_bg.wasm'))
  await init({ module_or_path: bytes })
})

test.describe('Starknet WASM contract', () => {
  test('pins public Starknet product capabilities and keeps STRK20 off the product pin', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'wasm-integrity.json'), 'utf8'))
    const info = new WalletEngine().coreInfo()
    expect(info.apiVersion).toBe(11)
    expect(info.capabilities).toEqual(expect.arrayContaining(['starknet_external_signer']))
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        'account.starknet.derive',
        'starknet.invoke.sign',
        'starknet.deploy-account.sign',
        'starknet.typed-data.sign'
      ])
    )
    expect(manifest.capabilities.join('\n')).not.toMatch(/strk20|quantus/i)
    expect(manifest.abiVersion).toBe('wallet-engine-1659f95-v11')
    expect(manifest.sourceCommit).toBe('1659f959ca34f07072c0fe75c8c07b12eebe348c')
  })

  test('locks software derivation, Argent v0.4, invoke, deploy, typed data, and external signatures', () => {
    const engine = new WalletEngine()
    const argent = engine.computeStarknetAccountAddress(
      JSON.stringify({ preset: 'argent_v0_4', publicKey: PUBLIC_KEY })
    )
    expect(argent.address).toBe(ARGENT_V0_4_ADDRESS)

    const vault = engine.importWallet(MNEMONIC, PASSWORD, '')
    const session = engine.unlock(vault, PASSWORD)
    const derived = engine.deriveStarknetAccount(session.sessionId, CHAIN, 0, 0, CLASS_HASH)
    expect(derived.address).toBe(OZ_ADDRESS)
    expect(derived.publicKey).toBe(PUBLIC_KEY)
    expect(derived.derivationPath).toBe("m/44'/9004'/0'/0/0")

    const prepared = engine.prepareStarknetInvoke(
      session.sessionId,
      JSON.stringify({
        chainId: CHAIN,
        accountIndex: 0,
        addressIndex: 0,
        classHash: CLASS_HASH,
        calls: [VECTOR_CALL],
        nonce: '0x7',
        resourceBounds: RESOURCE_BOUNDS
      })
    )
    expect(prepared.signingHash).toBe(INVOKE_HASH)
    const signed = engine.confirmStarknetInvoke(session.sessionId, prepared.requestId)

    const deploy = engine.prepareStarknetDeployAccount(
      session.sessionId,
      JSON.stringify({
        chainId: CHAIN,
        accountIndex: 0,
        addressIndex: 0,
        classHash: CLASS_HASH,
        nonce: '0x0',
        resourceBounds: RESOURCE_BOUNDS
      })
    )
    expect(deploy.signingHash).toBe(DEPLOY_HASH)

    const typed = engine.prepareStarknetTypedData(
      session.sessionId,
      JSON.stringify({
        chainId: CHAIN,
        accountIndex: 0,
        addressIndex: 0,
        classHash: CLASS_HASH,
        typedData: TYPED_DATA
      })
    )
    expect(typed.signingHash).toBe(TYPED_DATA_HASH)
    engine.lock(session.sessionId)

    const unsigned = engine.buildStarknetUnsignedInvoke(
      JSON.stringify({
        chainId: CHAIN,
        senderAddress: OZ_ADDRESS,
        publicKey: PUBLIC_KEY,
        calls: [VECTOR_CALL],
        nonce: '0x7',
        resourceBounds: RESOURCE_BOUNDS
      })
    )
    expect(unsigned.transactionHash).toBe(INVOKE_HASH)
    expect(unsigned.transaction.version).toBe('0x3')
    expect(unsigned.query).toBe(false)

    const query = engine.buildStarknetUnsignedInvoke(
      JSON.stringify({
        chainId: CHAIN,
        senderAddress: OZ_ADDRESS,
        publicKey: PUBLIC_KEY,
        calls: [VECTOR_CALL],
        nonce: '0x7',
        resourceBounds: RESOURCE_BOUNDS,
        query: true
      })
    )
    expect(query.transactionHash).not.toBe(INVOKE_HASH)
    expect(query.transaction.version).toBe(QUERY_VERSION)
    expect(query.query).toBe(true)
    expect(query.query === true || query.transaction.version !== '0x3').toBe(true)

    const attached = engine.attachStarknetSignature(
      JSON.stringify({
        chainId: CHAIN,
        publicKey: PUBLIC_KEY,
        signature: signed.signature,
        transaction: unsigned.transaction
      })
    )
    expect(attached.transactionHash).toBe(INVOKE_HASH)
    expect(attached.signature).toEqual(signed.signature)
    expect(() =>
      engine.attachStarknetSignature(
        JSON.stringify({
          chainId: CHAIN,
          publicKey: PUBLIC_KEY,
          signature: [signed.signature[1], signed.signature[0]],
          transaction: unsigned.transaction
        })
      )
    ).toThrow()
    engine.free()
  })
})
