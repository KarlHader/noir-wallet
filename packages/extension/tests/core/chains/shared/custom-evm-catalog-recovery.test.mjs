import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  parseCustomEvmNetwork
} from '../../../../src/core/chains/chain-endpoint-settings.ts'
import {
  removeCustomEvmNetworkSettings,
  saveCustomEvmNetworkSettings
} from '../../../../src/core/chains/custom-evm-network-settings.ts'
import { resolveEvmNetworkCatalog } from '../../../../src/core/chains/evm-runtime-config.ts'
import { createInitialProductChainRegistry } from '../../../../src/core/chains/registry/index.ts'
import {
  createDetectedEvmAssetRecord,
  createUserEvmAssetCandidate,
  createUserEvmAssetRecord
} from '../../../../src/core/chains/user-assets/index.ts'
import {
  ChromeDetectedEvmAssetCatalogRepository,
  getDetectedEvmAssetCatalogStorageKey
} from '../../../../src/infrastructure/chains/evm/chrome-detected-evm-asset-catalog.ts'
import {
  ChromeUserEvmAssetCatalogRepository,
  getUserEvmAssetCatalogStorageKey
} from '../../../../src/infrastructure/chains/evm/chrome-user-evm-asset-catalog.ts'
import { createBackgroundUserEvmAssetRuntime } from '../../../../src/background/user-evm-assets.ts'

const customNetwork = parseCustomEvmNetwork({
  chainId: 'eip155:31337',
  numericChainId: 31337,
  displayName: 'Local EVM',
  nativeCurrency: { name: 'Local Ether', symbol: 'LETH', decimals: 18 },
  rpc: { protocol: 'evm-json-rpc', label: 'Local RPC', url: 'http://localhost:8545' }
})
const configured = saveCustomEvmNetworkSettings(DEFAULT_CHAIN_ENDPOINT_SETTINGS, customNetwork)
const removed = removeCustomEvmNetworkSettings(configured, customNetwork)
const now = 1_800_000_000_000

function chainsFor(settings) {
  const custom = resolveEvmNetworkCatalog('mainnet', settings).filter(
    item => item.source === 'custom'
  )
  return createInitialProductChainRegistry('mainnet', custom)
}

function memoryChrome() {
  const storage = new Map()
  return {
    storage,
    chrome: {
      storage: {
        local: {
          get: async key => ({ ...(storage.has(key) ? { [key]: storage.get(key) } : {}) }),
          set: async values => {
            for (const [key, value] of Object.entries(values)) storage.set(key, value)
          },
          remove: async key => storage.delete(key)
        }
      }
    }
  }
}

function userRecord(chains, chainId, address, symbol) {
  return createUserEvmAssetRecord(
    chains,
    createUserEvmAssetCandidate(chains, {
      chainId,
      contractAddress: address,
      metadata: { name: `${symbol} Token`, symbol, decimals: 18 },
      inspectedAt: now
    }),
    now
  )
}

function detectedRecord(chains, chainId, address, symbol) {
  return createDetectedEvmAssetRecord(chains, {
    chainId,
    contractAddress: address,
    metadata: { name: `${symbol} Token`, symbol, decimals: 18 },
    detectedAt: now,
    lastSeenAt: now
  })
}

async function restartAssetRuntime(settings) {
  const previousOrigin = globalThis.__EVM_HISTORY_API_ORIGIN__
  globalThis.__EVM_HISTORY_API_ORIGIN__ = ''
  try {
    return await createBackgroundUserEvmAssetRuntime(resolveEvmNetworkCatalog('mainnet', settings))
  } finally {
    if (previousOrigin === undefined) delete globalThis.__EVM_HISTORY_API_ORIGIN__
    else globalThis.__EVM_HISTORY_API_ORIGIN__ = previousOrigin
  }
}

test('deleted custom-chain user Tokens stay dormant while other chains remain writable', async () => {
  const previousChrome = globalThis.chrome
  const memory = memoryChrome()
  globalThis.chrome = memory.chrome
  try {
    const activeChains = chainsFor(configured)
    const custom = userRecord(activeChains, customNetwork.chainId, `0x${'1'.repeat(40)}`, 'LOCAL')
    const ethereum = userRecord(activeChains, 'eip155:1', `0x${'2'.repeat(40)}`, 'ETHA')
    const original = new ChromeUserEvmAssetCatalogRepository('mainnet', activeChains)
    await original.insert(custom)
    await original.insert(ethereum)

    const afterDeletion = new ChromeUserEvmAssetCatalogRepository('mainnet', chainsFor(removed))
    assert.deepEqual(await afterDeletion.list(), [ethereum])
    const another = userRecord(chainsFor(removed), 'eip155:1', `0x${'3'.repeat(40)}`, 'ETHB')
    await afterDeletion.insert(another)
    assert.deepEqual(await afterDeletion.list(), [ethereum, another])
    const updated = {
      ...ethereum,
      metadata: { ...ethereum.metadata, name: 'Updated Ethereum Token' }
    }
    await afterDeletion.update(updated)
    assert.equal(await afterDeletion.remove(another.assetId), true)
    assert.deepEqual(await afterDeletion.list(), [updated])
    assert.equal(memory.storage.get(getUserEvmAssetCatalogStorageKey('mainnet')).assets.length, 2)
    assert.equal(Object.isFrozen(await afterDeletion.list()), true)
    const runtime = await restartAssetRuntime(removed)
    assert.equal(runtime.catalogStatus, 'ready')
    assert.deepEqual(runtime.records, [updated])
    assert.ok(runtime.definitions.every(asset => asset.chainId !== customNetwork.chainId))
    await assert.rejects(
      runtime.coordinator.inspect({
        chainId: customNetwork.chainId,
        contractAddress: custom.contractAddress
      }),
      /Unsupported chain/
    )

    const afterReadd = new ChromeUserEvmAssetCatalogRepository('mainnet', chainsFor(configured))
    assert.deepEqual(await afterReadd.list(), [custom, updated])
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
  }
})

test('deleted custom-chain detected Tokens do not block other inventory or re-add recovery', async () => {
  const previousChrome = globalThis.chrome
  const memory = memoryChrome()
  globalThis.chrome = memory.chrome
  try {
    const activeChains = chainsFor(configured)
    const custom = detectedRecord(
      activeChains,
      customNetwork.chainId,
      `0x${'4'.repeat(40)}`,
      'LOCD'
    )
    const ethereum = detectedRecord(activeChains, 'eip155:1', `0x${'5'.repeat(40)}`, 'ETHD')
    const original = new ChromeDetectedEvmAssetCatalogRepository('mainnet', activeChains)
    await original.upsert([custom, ethereum])

    const afterDeletion = new ChromeDetectedEvmAssetCatalogRepository('mainnet', chainsFor(removed))
    assert.deepEqual(await afterDeletion.list(), [ethereum])
    const another = detectedRecord(chainsFor(removed), 'eip155:1', `0x${'6'.repeat(40)}`, 'ETHE')
    await afterDeletion.upsert([another])
    assert.deepEqual(await afterDeletion.list(), [ethereum, another])
    assert.equal(
      memory.storage.get(getDetectedEvmAssetCatalogStorageKey('mainnet')).assets.length,
      3
    )
    assert.equal(Object.isFrozen(await afterDeletion.list()), true)
    const runtime = await restartAssetRuntime(removed)
    assert.equal(runtime.catalogStatus, 'ready')
    assert.deepEqual(runtime.detectedRecords, [ethereum, another])
    assert.ok(runtime.definitions.every(asset => asset.chainId !== customNetwork.chainId))

    const afterReadd = new ChromeDetectedEvmAssetCatalogRepository('mainnet', chainsFor(configured))
    assert.deepEqual(await afterReadd.list(), [custom, ethereum, another])
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
  }
})

test('dormant records still require canonical identity, metadata, uniqueness, and capacity', async () => {
  const previousChrome = globalThis.chrome
  const memory = memoryChrome()
  globalThis.chrome = memory.chrome
  try {
    const activeChains = chainsFor(configured)
    const custom = userRecord(activeChains, customNetwork.chainId, `0x${'7'.repeat(40)}`, 'LOCAL')
    const detected = detectedRecord(
      activeChains,
      customNetwork.chainId,
      `0x${'8'.repeat(40)}`,
      'LOCD'
    )
    const userKey = getUserEvmAssetCatalogStorageKey('mainnet')
    const detectedKey = getDetectedEvmAssetCatalogStorageKey('mainnet')
    const userAfterDeletion = new ChromeUserEvmAssetCatalogRepository('mainnet', chainsFor(removed))
    const detectedAfterDeletion = new ChromeDetectedEvmAssetCatalogRepository(
      'mainnet',
      chainsFor(removed)
    )

    memory.storage.set(userKey, {
      version: 1,
      assets: [{ ...custom, metadata: { ...custom.metadata, symbol: ' BAD' } }]
    })
    await assert.rejects(userAfterDeletion.list(), /asset symbol/)
    memory.storage.set(userKey, { version: 1, assets: [custom, custom] })
    await assert.rejects(userAfterDeletion.list(), /Duplicate/)
    memory.storage.set(userKey, { version: 1, assets: Array(65).fill(custom) })
    await assert.rejects(userAfterDeletion.list(), /Invalid user EVM Token catalog/)

    memory.storage.set(detectedKey, {
      version: 1,
      assets: [{ ...detected, assetId: 'eip155:31337/erc20:0xdead' }]
    })
    await assert.rejects(detectedAfterDeletion.list(), /canonical/)
    memory.storage.set(detectedKey, { version: 1, assets: [detected, detected] })
    await assert.rejects(detectedAfterDeletion.list(), /Duplicate/)
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
  }
})
