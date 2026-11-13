import { test } from 'node:test'
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import init, { WalletEngine } from '../../../../src/infrastructure/generated/wasm/multichain/wallet_wasm.js'
import {
  starknetDeployExternalRequest,
  starknetDeployFeeEstimateTransaction,
  starknetInvokeExternalRequest,
  starknetInvokeFeeEstimateTransaction
} from '../../../../src/infrastructure/chains/starknet/starknet-external-transaction.ts'
import {
  assertStarknetFelt,
  feltToBigint,
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_EXECUTION_VERSION,
  STARKNET_OZ_CLASS_HASH,
  STARKNET_QUERY_VERSION
} from '../../../../src/infrastructure/chains/starknet/starknet-primitives.ts'

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src/infrastructure/generated/wasm/multichain'
)
const MNEMONIC = 'test test test test test test test test test test test junk'
const PASSWORD = 'starknet-wasm-contract'
const CHAIN = 'starknet:SN_MAIN'
const PUBLIC_KEY = '0x7f0ecd1ec6159e6a7c70084aaa7d693d9113149b80ab72618602a185e2c1f2b'
const OZ_ADDRESS = '0x58ac366fa8dc98e25a85c7343bcca64324c2e7e65c017785c363d1066ce072a'
const ARGENT_V0_4_ADDRESS = '0x6a62e3abc08f1190cf071afeec31d1693f71c9f126e820b98d7017f133e6a27'
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

function sameFelt(actual, expected) {
  return (
    feltToBigint(assertStarknetFelt(String(actual).toLowerCase(), 'felt')) ===
    feltToBigint(assertStarknetFelt(String(expected).toLowerCase(), 'felt'))
  )
}

function expectFelt(actual, expected) {
  expect(sameFelt(actual, expected)).toBe(true)
}

function expectFelts(actual, expected) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((felt, index) => expectFelt(felt, expected[index]))
}

function sessionInvoke(classHash) {
  return JSON.stringify({
    chainId: CHAIN,
    accountIndex: 0,
    addressIndex: 0,
    classHash,
    calls: [VECTOR_CALL],
    nonce: '0x7',
    resourceBounds: RESOURCE_BOUNDS
  })
}

function assertQueryInvoke(request, summary) {
  const query = starknetInvokeFeeEstimateTransaction(request, summary)
  expect(query.version).toBe(STARKNET_QUERY_VERSION)
  expect(query.signature).toEqual([])
  expect(query.type).toBe('INVOKE')
  expectFelt(query.sender_address, summary.senderAddress)
  expectFelt(query.nonce, summary.nonce)
  expect(query.calldata[0]).toBeTruthy()
  expectFelt(query.calldata[0], `0x${summary.calls.length.toString(16)}`)
  let offset = 1
  for (const call of summary.calls) {
    expectFelt(query.calldata[offset], call.to)
    expectFelt(query.calldata[offset + 1], call.selector)
    expectFelt(query.calldata[offset + 2], `0x${call.calldata.length.toString(16)}`)
    call.calldata.forEach((felt, index) => expectFelt(query.calldata[offset + 3 + index], felt))
    offset += 3 + call.calldata.length
  }
  expect(query.calldata).toHaveLength(offset)
  return query
}

function assertQueryDeploy(request, summary) {
  const query = starknetDeployFeeEstimateTransaction(request, summary)
  expect(query.version).toBe(STARKNET_QUERY_VERSION)
  expect(query.signature).toEqual([])
  expect(query.type).toBe('DEPLOY_ACCOUNT')
  expectFelt(query.class_hash, summary.classHash)
  expectFelt(query.contract_address_salt, summary.salt)
  expectFelts(query.constructor_calldata, summary.constructorCalldata)
  return query
}

test.before(async () => {
  const bytes = readFileSync(path.join(packageDir, 'wallet_wasm_bg.wasm'))
  await init({ module_or_path: bytes })
})

test.describe('Starknet WASM contract', () => {
  test('pins API 10 and keeps STRK20 off the product pin', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'wasm-integrity.json'), 'utf8'))
    const info = new WalletEngine().coreInfo()
    expect(info.apiVersion).toBe(10)
    expect(info.capabilities).toEqual(expect.arrayContaining(['starknet_external_signer']))
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        'account.starknet.derive',
        'starknet.invoke.sign',
        'starknet.deploy-account.sign',
        'starknet.typed-data.sign'
      ])
    )
    expect(manifest.capabilities.join('\n')).not.toMatch(/strk20/i)
    expect(manifest.abiVersion).toBe('wallet-engine-fc72763-v10')
    expect(manifest.sourceCommit).toBe('fc727637f4df9d3bf9bc2d0cd946e0df2e16dc05')
  })

  test('computes, prepares, assembles, and verifies OpenZeppelin and Argent v0.4 accounts', () => {
    const engine = new WalletEngine()
    const openZeppelin = engine.computeStarknetAccountAddress(
      JSON.stringify({
        chainId: CHAIN,
        publicKey: PUBLIC_KEY,
        implementation: 'open_zeppelin'
      })
    )
    const argent = engine.computeStarknetAccountAddress(
      JSON.stringify({ chainId: CHAIN, publicKey: PUBLIC_KEY, implementation: 'argent_v04' })
    )
    expect(openZeppelin.account).toBeUndefined()
    expect(openZeppelin.salt).toBeUndefined()
    expect(openZeppelin.constructorCalldata).toBeUndefined()
    expect(openZeppelin).toMatchObject({ implementation: 'open_zeppelin', source: 'external' })
    expectFelt(openZeppelin.address, OZ_ADDRESS)
    expectFelt(openZeppelin.classHash, STARKNET_OZ_CLASS_HASH)
    expectFelt(openZeppelin.publicKey, PUBLIC_KEY)
    expect(argent).toMatchObject({ implementation: 'argent_v04', source: 'external' })
    expectFelt(argent.address, ARGENT_V0_4_ADDRESS)
    expectFelt(argent.classHash, STARKNET_ARGENT_V04_CLASS_HASH)
    expect(() =>
      engine.computeStarknetAccountAddress(
        JSON.stringify({ chainId: CHAIN, publicKey: PUBLIC_KEY, preset: 'argent_v0_4' })
      )
    ).toThrow()

    const vault = engine.importWallet(MNEMONIC, PASSWORD, '')
    const session = engine.unlock(vault, PASSWORD)
    const derived = engine.deriveStarknetAccount(
      session.sessionId,
      CHAIN,
      0,
      0,
      STARKNET_OZ_CLASS_HASH
    )
    expectFelt(derived.address, openZeppelin.address)
    expectFelt(derived.publicKey, PUBLIC_KEY)
    expect(derived.derivationPath).toBe("m/44'/9004'/0'/0/0")

    const invokeRequest = starknetInvokeExternalRequest({
      chainId: CHAIN,
      publicKey: PUBLIC_KEY,
      accountAddress: openZeppelin.address,
      classHash: STARKNET_OZ_CLASS_HASH,
      calls: [VECTOR_CALL],
      nonce: '0x7',
      resourceBounds: RESOURCE_BOUNDS
    })
    const sessionInvokePrepared = engine.prepareStarknetInvoke(
      session.sessionId,
      sessionInvoke(STARKNET_OZ_CLASS_HASH)
    )
    const externalInvoke = engine.prepareStarknetInvokeExternal(JSON.stringify(invokeRequest))
    expect(externalInvoke.invokeTransaction).toBeUndefined()
    expect(externalInvoke.query).toBeUndefined()
    expect(externalInvoke.signingHash).toBeTruthy()
    expect(externalInvoke.messageHash).toBeUndefined()
    expectFelt(externalInvoke.signingHash, sessionInvokePrepared.signingHash)
    expectFelt(externalInvoke.summary.senderAddress, openZeppelin.address)
    const invokeQuery = assertQueryInvoke(invokeRequest, externalInvoke.summary)
    expect(invokeQuery.version).not.toBe(STARKNET_EXECUTION_VERSION)
    const signedInvoke = engine.confirmStarknetInvoke(
      session.sessionId,
      sessionInvokePrepared.requestId
    )
    const assembledInvoke = engine.assembleStarknetInvokeExternal(
      JSON.stringify({ ...invokeRequest, signature: signedInvoke.signature })
    )
    expectFelt(assembledInvoke.transactionHash, externalInvoke.signingHash)
    expect(assembledInvoke.signature).toEqual(signedInvoke.signature)
    expect(assembledInvoke.invokeTransaction.version).toBe(STARKNET_EXECUTION_VERSION)
    expect(assembledInvoke.invokeTransaction.signature).toEqual(signedInvoke.signature)
    expect(assembledInvoke.invokeTransaction.version).not.toBe(STARKNET_QUERY_VERSION)
    expect(
      engine.verifyStarknetSignature(
        JSON.stringify({
          hash: externalInvoke.signingHash,
          publicKey: PUBLIC_KEY,
          signature: signedInvoke.signature
        })
      )
    ).toBe(true)
    expect(
      engine.verifyStarknetSignature(
        JSON.stringify({
          hash: externalInvoke.signingHash,
          publicKey: PUBLIC_KEY,
          signature: [signedInvoke.signature[1], signedInvoke.signature[0]]
        })
      )
    ).toBe(false)
    expect(() =>
      engine.assembleStarknetInvokeExternal(
        JSON.stringify({
          ...invokeRequest,
          signature: [signedInvoke.signature[1], signedInvoke.signature[0]]
        })
      )
    ).toThrow()
    expect(() =>
      engine.verifyStarknetSignature(
        JSON.stringify({
          hash: externalInvoke.signingHash,
          publicKey: PUBLIC_KEY,
          signature: [signedInvoke.signature[0]]
        })
      )
    ).toThrow()

    const deployRequest = starknetDeployExternalRequest({
      chainId: CHAIN,
      publicKey: PUBLIC_KEY,
      accountAddress: openZeppelin.address,
      classHash: STARKNET_OZ_CLASS_HASH,
      nonce: '0x0',
      resourceBounds: RESOURCE_BOUNDS
    })
    const sessionDeploy = engine.prepareStarknetDeployAccount(
      session.sessionId,
      JSON.stringify({
        chainId: CHAIN,
        accountIndex: 0,
        addressIndex: 0,
        classHash: STARKNET_OZ_CLASS_HASH,
        nonce: '0x0',
        resourceBounds: RESOURCE_BOUNDS
      })
    )
    const externalDeploy = engine.prepareStarknetDeployAccountExternal(JSON.stringify(deployRequest))
    expect(externalDeploy.deployAccountTransaction).toBeUndefined()
    expectFelt(externalDeploy.signingHash, sessionDeploy.signingHash)
    expectFelt(externalDeploy.summary.contractAddress, openZeppelin.address)
    expectFelt(externalDeploy.summary.classHash, STARKNET_OZ_CLASS_HASH)
    expectFelts(externalDeploy.summary.constructorCalldata, [PUBLIC_KEY])
    assertQueryDeploy(deployRequest, externalDeploy.summary)
    const signedDeploy = engine.confirmStarknetDeployAccount(
      session.sessionId,
      sessionDeploy.requestId
    )
    const assembledDeploy = engine.assembleStarknetDeployAccountExternal(
      JSON.stringify({ ...deployRequest, signature: signedDeploy.signature })
    )
    expectFelt(assembledDeploy.transactionHash, externalDeploy.signingHash)
    expectFelt(assembledDeploy.contractAddress, openZeppelin.address)
    expect(assembledDeploy.deployAccountTransaction.version).toBe(STARKNET_EXECUTION_VERSION)
    expect(assembledDeploy.deployAccountTransaction.signature).toEqual(signedDeploy.signature)
    expect(
      engine.verifyStarknetSignature(
        JSON.stringify({
          hash: externalDeploy.signingHash,
          publicKey: PUBLIC_KEY,
          signature: signedDeploy.signature
        })
      )
    ).toBe(true)

    const sessionTyped = engine.prepareStarknetTypedData(
      session.sessionId,
      JSON.stringify({
        chainId: CHAIN,
        accountIndex: 0,
        addressIndex: 0,
        classHash: STARKNET_OZ_CLASS_HASH,
        typedData: TYPED_DATA
      })
    )
    const hashed = engine.hashStarknetTypedData(
      JSON.stringify({
        chainId: CHAIN,
        accountAddress: openZeppelin.address,
        publicKey: PUBLIC_KEY,
        implementation: 'open_zeppelin',
        typedData: TYPED_DATA
      })
    )
    expect(hashed.messageHash).toBeUndefined()
    expectFelt(hashed.signingHash, sessionTyped.signingHash)
    const signedTyped = engine.confirmStarknetTypedData(session.sessionId, sessionTyped.requestId)
    expect(
      engine.verifyStarknetSignature(
        JSON.stringify({
          hash: hashed.signingHash,
          publicKey: PUBLIC_KEY,
          signature: signedTyped.signature
        })
      )
    ).toBe(true)
    engine.lock(session.sessionId)

    const argentVault = engine.importStarknetAccount(MNEMONIC, PASSWORD, '', argent.address)
    const argentSession = engine.unlock(argentVault, PASSWORD)
    const argentInvokeRequest = starknetInvokeExternalRequest({
      chainId: CHAIN,
      publicKey: PUBLIC_KEY,
      accountAddress: argent.address,
      classHash: STARKNET_ARGENT_V04_CLASS_HASH,
      calls: [VECTOR_CALL],
      nonce: '0x7',
      resourceBounds: RESOURCE_BOUNDS
    })
    const argentSessionInvoke = engine.prepareStarknetInvoke(
      argentSession.sessionId,
      sessionInvoke(STARKNET_ARGENT_V04_CLASS_HASH)
    )
    const argentInvoke = engine.prepareStarknetInvokeExternal(JSON.stringify(argentInvokeRequest))
    expect(argentInvoke.invokeTransaction).toBeUndefined()
    expectFelt(argentInvoke.signingHash, argentSessionInvoke.signingHash)
    expectFelt(argentInvoke.summary.senderAddress, argent.address)
    expect(argentInvoke.account.implementation).toBe('argent_v04')
    assertQueryInvoke(argentInvokeRequest, argentInvoke.summary)
    const argentSigned = engine.confirmStarknetInvoke(
      argentSession.sessionId,
      argentSessionInvoke.requestId
    )
    const argentAssembled = engine.assembleStarknetInvokeExternal(
      JSON.stringify({ ...argentInvokeRequest, signature: argentSigned.signature })
    )
    expect(argentAssembled.invokeTransaction.version).toBe(STARKNET_EXECUTION_VERSION)
    expectFelt(argentAssembled.transactionHash, argentInvoke.signingHash)
    expect(
      engine.verifyStarknetSignature(
        JSON.stringify({
          hash: argentInvoke.signingHash,
          publicKey: PUBLIC_KEY,
          signature: argentSigned.signature
        })
      )
    ).toBe(true)

    const argentDeployRequest = starknetDeployExternalRequest({
      chainId: CHAIN,
      publicKey: PUBLIC_KEY,
      accountAddress: argent.address,
      classHash: STARKNET_ARGENT_V04_CLASS_HASH,
      nonce: '0x0',
      resourceBounds: RESOURCE_BOUNDS
    })
    const argentDeploy = engine.prepareStarknetDeployAccountExternal(
      JSON.stringify(argentDeployRequest)
    )
    expect(argentDeploy.deployAccountTransaction).toBeUndefined()
    expectFelt(argentDeploy.summary.contractAddress, argent.address)
    expectFelt(argentDeploy.summary.classHash, STARKNET_ARGENT_V04_CLASS_HASH)
    expectFelt(argentDeploy.summary.salt, PUBLIC_KEY)
    expectFelts(argentDeploy.summary.constructorCalldata, ['0x0', PUBLIC_KEY, '0x1'])
    const argentDeployQuery = assertQueryDeploy(argentDeployRequest, argentDeploy.summary)
    expect(argentDeployQuery.version).toBe(STARKNET_QUERY_VERSION)
    expect(argentDeploy.account.implementation).toBe('argent_v04')
    const argentTyped = engine.hashStarknetTypedData(
      JSON.stringify({
        chainId: CHAIN,
        accountAddress: argent.address,
        publicKey: PUBLIC_KEY,
        implementation: 'argent_v04',
        typedData: TYPED_DATA
      })
    )
    expect(argentTyped.messageHash).toBeUndefined()
    expect(argentTyped.signingHash).toBeTruthy()
    expect(argentTyped.account.implementation).toBe('argent_v04')
    engine.lock(argentSession.sessionId)
    engine.free()
  })
})
