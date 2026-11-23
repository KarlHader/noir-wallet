import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import {
  createAddressGatedChainRegistry,
  createAssetRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions,
  getZcashChainId
} from '../../../../src/core/chains/registry/index.ts'
import {
  nearFungibleAssetId,
  nearPortfolioPrivateAccountId,
  selectNearPortfolioTokens
} from '../../../../src/core/chains/near/near-portfolio-assets.ts'
import {
  embeddedConfidentialRaw,
  selectDomainBalanceRaw
} from '../../../../src/core/portfolio/domain-balance-policy.ts'
import { parsePortfolioBalanceSnapshot } from '../../../../src/core/portfolio/portfolio-parsing.ts'
import { getDetectedNearAssetCatalogStorageKey } from '../../../../src/infrastructure/chains/near/near-detected-asset-catalog.ts'
import { readNearPortfolioSource } from '../../../../src/infrastructure/chains/near/near-portfolio-source.ts'

const nearChainId = NEAR_NETWORKS.testnet.chainId
const mainAddress = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const peaAddress = 'a'.repeat(64)
const blockHash = '11111111111111111111111111111111'
const keyDomainId = 'wallet:near-portfolio'
const accountId = 'account:near-portfolio:0'

const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.near'
])

function chainAccount(address = mainAddress) {
  return Object.freeze({
    id: 'chain-account:near-portfolio',
    scope: { keyDomainId, accountId, chainId: nearChainId },
    derivation: { scheme: 'slip10', path: "m/44'/397'/0'" },
    identity: { kind: 'account-identifier', value: address },
    createdAt: 1_000
  })
}

function accountView(address, amountRaw, lockedRaw) {
  return {
    accountId: address,
    amountRaw,
    lockedRaw,
    storageUsage: 30,
    codeHash: blockHash,
    blockHash,
    blockHeight: 40
  }
}

function nativeAssets() {
  return createAssetRegistry(
    chains,
    filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains)
  )
}

function rpc(getAccount) {
  return {
    assertExpectedChain: async () => {},
    getAccount,
    getFinalBlock: async () => ({
      hash: blockHash,
      height: 41,
      timestampNanosec: '1',
      gasPriceRaw: '1'
    }),
    getFungibleTokenBalance: async () => {
      throw new Error('Native-only Portfolio must not query NEP-141 balances')
    }
  }
}

function balanceView(chainId, balance) {
  return { asset: { id: `${chainId}/native`, chainId }, balance }
}

test('keeps the NEAR detected catalog separate from the EVM catalog', () => {
  expect(getDetectedNearAssetCatalogStorageKey('mainnet')).toBe(
    'detected_near_asset_catalog_mainnet_v1'
  )
  expect(getDetectedNearAssetCatalogStorageKey('testnet')).toBe(
    'detected_near_asset_catalog_testnet_v1'
  )
})

test('truncates NEAR token reads to 64 after user-enabled holdings and bundled defaults', async () => {
  const contracts = Array.from(
    { length: 70 },
    (_, index) => `t${String(index).padStart(2, '0')}.near`
  )
  const assets = createAssetRegistry(chains, [
    ...filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains),
    ...contracts.map(contractId => ({
      chainId: nearChainId,
      namespace: 'nep141',
      reference: contractId,
      kind: 'token',
      metadata: { name: contractId, symbol: 'T', decimals: 6 },
      source: 'bundled',
      verification: 'trusted'
    })),
    {
      chainId: nearChainId,
      namespace: 'nep141',
      reference: 'usdc.omft.near',
      kind: 'token',
      metadata: { name: 'USDC', symbol: 'USDC', decimals: 6 },
      source: 'bundled',
      verification: 'trusted'
    }
  ])
  const called = []
  const snapshot = await readNearPortfolioSource({
    chainAccount: chainAccount(),
    assets,
    rpc: {
      assertExpectedChain: async () => {},
      getAccount: async requested => accountView(requested, '100', '20'),
      getFinalBlock: async () => ({
        hash: blockHash,
        height: 41,
        timestampNanosec: '1',
        gasPriceRaw: '1'
      }),
      getFungibleTokenBalance: async (contractId, requestedAccountId) => {
        called.push(contractId)
        return {
          contractId,
          accountId: requestedAccountId,
          amountRaw: '1',
          blockHash,
          blockHeight: 40
        }
      }
    },
    userEnabledAssetIds: new Set([nearFungibleAssetId(nearChainId, contracts[69])]),
    now: () => 1_700_000_000_000
  })

  const kept = [contracts[69], ...contracts.slice(0, 63)]
  expect(snapshot.status).toBe('ready')
  expect(called).toEqual(kept)
  expect(snapshot.balances.map(balance => balance.assetId)).toEqual([
    `${nearChainId}/slip44:397`,
    ...kept.map(contractId => nearFungibleAssetId(nearChainId, contractId))
  ])
  expect(snapshot.balances.some(balance => balance.assetId.includes('omft'))).toBe(false)
  const native = snapshot.balances[0]
  expect(native).toMatchObject({
    totalRaw: '120',
    spendableRaw: '100',
    availableRaw: '100',
    mainRaw: '120',
    privateRaw: '0',
    privateOnchainRaw: '0',
    confidentialRaw: '0'
  })
})

test('ignores FastNear rows past the 2048 inventory cap and bridge contracts', async () => {
  const rows = Array.from({ length: 2_049 }, (_, index) => ({
    contractId: `z${String(index).padStart(4, '0')}.near`,
    amountRaw: '0',
    lastUpdateBlockHeight: 1
  }))
  rows[0] = { contractId: 'usdc.omft.near', amountRaw: '9', lastUpdateBlockHeight: 1 }
  rows[2_047] = { contractId: 'kept.near', amountRaw: '5', lastUpdateBlockHeight: 2 }
  rows[2_048] = { contractId: 'dropped.near', amountRaw: '7', lastUpdateBlockHeight: 3 }
  const metadataCalls = []
  const detected = []
  const snapshot = await readNearPortfolioSource({
    chainAccount: chainAccount(),
    assets: nativeAssets(),
    rpc: {
      ...rpc(async requested => accountView(requested, '1', '0')),
      viewFunction: async contractId => {
        metadataCalls.push(contractId)
        return { name: 'Kept', symbol: 'KEEP', decimals: 8, spec: 'ft-1.0.0' }
      }
    },
    tokenInventory: { getFungibleTokenBalances: async () => rows },
    onDetectedTokens: async tokens => {
      detected.push(...tokens)
    },
    now: () => 1_700_000_000_000
  })
  expect(snapshot.status).toBe('ready')
  expect(metadataCalls).toEqual(['kept.near'])
  expect(detected.map(token => token.contractId)).toEqual(['kept.near'])
})

test('merges NEAR Main and PEA balances and treats a missing PEA account as zero', async () => {
  const seen = []
  const snapshot = await readNearPortfolioSource({
    chainAccount: chainAccount(),
    assets: nativeAssets(),
    rpc: rpc(async requested => {
      seen.push(requested)
      if (requested === peaAddress) return accountView(peaAddress, '30', '5')
      return accountView(mainAddress, '100', '20')
    }),
    privateExecution: {
      walletSource: { kind: 'software' },
      accountIndex: 0,
      address: peaAddress
    },
    now: () => 1_700_000_000_000
  })
  expect(seen).toEqual([mainAddress, peaAddress])
  expect(snapshot.balances[0]).toMatchObject({
    totalRaw: '155',
    spendableRaw: '130',
    availableRaw: '130',
    mainRaw: '120',
    privateRaw: '35',
    privateOnchainRaw: '35',
    confidentialRaw: '0'
  })

  const missing = []
  const missingSnapshot = await readNearPortfolioSource({
    chainAccount: chainAccount(),
    assets: nativeAssets(),
    rpc: rpc(async requested => {
      missing.push(requested)
      if (requested === peaAddress) return null
      return accountView(mainAddress, '100', '20')
    }),
    privateExecution: {
      walletSource: { kind: 'software' },
      accountIndex: 0,
      address: peaAddress
    },
    now: () => 1_700_000_000_000
  })
  expect(missing).toEqual([mainAddress, peaAddress])
  expect(missingSnapshot.status).toBe('ready')
  expect(missingSnapshot.balances[0]).toMatchObject({
    totalRaw: '120',
    spendableRaw: '100',
    mainRaw: '120',
    privateRaw: '0',
    privateOnchainRaw: '0',
    confidentialRaw: '0'
  })
})

test('does not read a PEA balance for hardware accounts', async () => {
  const execution = {
    walletSource: { kind: 'hardware' },
    accountIndex: 0,
    address: peaAddress
  }
  expect(nearPortfolioPrivateAccountId(execution, mainAddress)).toBeNull()
  const seen = []
  const snapshot = await readNearPortfolioSource({
    chainAccount: chainAccount(),
    assets: nativeAssets(),
    rpc: rpc(async requested => {
      seen.push(requested)
      return accountView(requested, '100', '20')
    }),
    privateExecution: execution,
    now: () => 1_700_000_000_000
  })
  expect(seen).toEqual([mainAddress])
  expect(snapshot.balances[0].privateOnchainRaw).toBe('0')
  expect(snapshot.balances[0].mainRaw).toBe('120')
})

test('keeps a totalRaw-only NEAR cache row on the public domain until refresh', () => {
  const parsed = parsePortfolioBalanceSnapshot({
    assetId: `${nearChainId}/slip44:397`,
    totalRaw: '120',
    spendableRaw: '100',
    availableRaw: '100',
    pendingRaw: '0',
    updatedAt: 1_700_000_000_000
  })
  expect(parsed.mainRaw).toBeUndefined()
  expect(parsed.privateRaw).toBeUndefined()
  const asset = balanceView(nearChainId, parsed)
  expect(selectDomainBalanceRaw(asset, 'public')).toBe('120')
  expect(selectDomainBalanceRaw(asset, 'shield')).toBe('0')
  expect(selectDomainBalanceRaw(asset, 'private')).toBe('0')

  const split = balanceView('near:mainnet', {
    totalRaw: '115',
    spendableRaw: '100',
    availableRaw: '100',
    pendingRaw: '0',
    mainRaw: '80',
    privateRaw: '35',
    privateOnchainRaw: '20',
    confidentialRaw: '15',
    updatedAt: 1
  })
  expect(selectDomainBalanceRaw(split, 'public')).toBe('80')
  expect(selectDomainBalanceRaw(split, 'shield')).toBe('15')
  expect(selectDomainBalanceRaw(split, 'private')).toBe('20')
  expect(embeddedConfidentialRaw(split, true)).toBe(15n)
  expect(embeddedConfidentialRaw(split, false)).toBe(0n)

  const evm = balanceView('eip155:1', {
    totalRaw: '14',
    spendableRaw: '14',
    availableRaw: '14',
    pendingRaw: '0',
    mainRaw: '10',
    privateRaw: '4',
    updatedAt: 1
  })
  expect(selectDomainBalanceRaw(evm, 'public')).toBe('10')
  expect(selectDomainBalanceRaw(evm, 'shield')).toBe('0')
  expect(selectDomainBalanceRaw(evm, 'private')).toBe('4')

  const zcash = balanceView(getZcashChainId('mainnet'), {
    totalRaw: '10',
    spendableRaw: '10',
    availableRaw: '10',
    pendingRaw: '0',
    transparentRaw: '3',
    shieldedRaw: '7',
    updatedAt: 1
  })
  expect(selectDomainBalanceRaw(zcash, 'public')).toBe('3')
  expect(selectDomainBalanceRaw(zcash, 'shield')).toBe('7')
  expect(selectDomainBalanceRaw(zcash, 'private')).toBe('0')
})

test('selects NEAR tokens in user, holding, bundled order and drops bridge contracts', () => {
  const token = (contractId, discovered = false) => ({
    contractId,
    assetId: nearFungibleAssetId(nearChainId, contractId),
    symbol: 'T',
    decimals: 6,
    name: contractId,
    discovered
  })
  const bundled = Array.from({ length: 70 }, (_, index) => token(`b${index}.near`))
  const selected = selectNearPortfolioTokens({
    userEnabled: [bundled[69], token('usdc.omft.near')],
    holdings: [token('hold.near', true)],
    bundled,
    registered: [token('late.near')]
  })
  expect(selected.map(entry => entry.contractId)).toEqual([
    'b69.near',
    'hold.near',
    ...Array.from({ length: 62 }, (_, index) => `b${index}.near`)
  ])
})
