import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import {
  buildConfidentialPortfolioView,
  excludeDeprecatedConfidentialAssets,
  confidentialPrivateTokenId,
  filterConfidentialPortfolioMappings,
  getConfidentialAvailableForAsset,
  mergeConfidentialBalancesIntoPortfolio
} from '../../../src/core/services/confidential-funding/confidential-funding-portfolio.ts'
import { getBitcoinChainId } from '../../../src/core/chains/registry/index.ts'

test('projects Shield-only holdings independently of Public assets and preserves unknown tokens', () => {
  const protocolAssetId = 'nep141:usdc.omft.near'
  const assetId = 'eip155:1/erc20:0x1111111111111111111111111111111111111111'
  const zcashChainId = 'bip122:00040fe8ec8471911baa1db1266ea15d'
  const zcashAssetId = `${zcashChainId}/slip44:133`
  const zcashProtocolId = 'nep141:zec.omft.near'
  const bitcoinAssetId = `${getBitcoinChainId('mainnet')}/slip44:0`
  const bitcoinProtocolId = 'nep141:btc.omft.near'
  const token = {
    assetId: protocolAssetId,
    blockchain: 'eth',
    contractAddress: '0x1111111111111111111111111111111111111111',
    decimals: 6,
    symbol: 'USDC',
    price: 1,
    priceUpdatedAt: '2026-01-01T00:00:00Z'
  }
  const legacyId = 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r'
  const legacyBalance = Object.freeze({
    tokenId: confidentialPrivateTokenId(legacyId),
    available: '1000000000000000000'
  })
  const view = buildConfidentialPortfolioView(
    [
      legacyBalance,
      { tokenId: protocolAssetId, available: '9' },
      { tokenId: confidentialPrivateTokenId(protocolAssetId), available: '42' },
      { tokenId: confidentialPrivateTokenId(zcashProtocolId), available: '140000' },
      { tokenId: confidentialPrivateTokenId(bitcoinProtocolId), available: '7000' },
      { tokenId: 'unknown:asset', available: '7' }
    ],
    [
      token,
      { ...token, assetId: legacyId, symbol: 'USDC(DEPRECATED)', decimals: 18 },
      {
        assetId: zcashProtocolId,
        blockchain: 'zec',
        decimals: 8,
        symbol: 'ZEC',
        price: 0
      }
    ],
    [{ protocolAssetId, assetId, chainId: 'eip155:1', blockchain: 'eth' }],
    filterConfidentialPortfolioMappings(
      [
        { assetId, protocolAssetId },
        { assetId: zcashAssetId, protocolAssetId: zcashProtocolId },
        { assetId: bitcoinAssetId, protocolAssetId: bitcoinProtocolId }
      ],
      'mainnet'
    ),
    {
      get: id =>
        id === zcashAssetId
          ? { asset: { id: zcashAssetId, chainId: zcashChainId } }
          : id === bitcoinAssetId
            ? { asset: { id: bitcoinAssetId, chainId: getBitcoinChainId('mainnet') } }
            : undefined
    }
  )
  expect(view.status).toBe('ready')
  expect(getConfidentialAvailableForAsset([legacyBalance], legacyId)).toBe('1000000000000000000')
  expect(view.assets).toEqual([
    expect.objectContaining({
      tokenId: confidentialPrivateTokenId(protocolAssetId),
      protocolAssetId,
      availableRaw: '42',
      assetId,
      chainId: 'eip155:1',
      decimals: 6,
      priceUsd: '1'
    }),
    expect.objectContaining({
      tokenId: confidentialPrivateTokenId(zcashProtocolId),
      protocolAssetId: zcashProtocolId,
      availableRaw: '140000',
      assetId: zcashAssetId,
      chainId: zcashChainId,
      decimals: 8
    }),
    {
      tokenId: confidentialPrivateTokenId(bitcoinProtocolId),
      protocolAssetId: bitcoinProtocolId,
      availableRaw: '7000'
    },
    { tokenId: 'unknown:asset', protocolAssetId: 'unknown:asset', availableRaw: '7' }
  ])
  expect(
    filterConfidentialPortfolioMappings(
      [{ assetId: zcashAssetId, protocolAssetId: zcashProtocolId }],
      'testnet'
    )
  ).toEqual([])
})

test('only counts the verified treasury token as Shield balance', () => {
  const asset = 'nep141:eth.omft.near'
  expect(
    getConfidentialAvailableForAsset(
      [
        { tokenId: `imt:${'a'.repeat(64)}:${asset}`, available: '9000' },
        { tokenId: asset, available: '7' },
        { tokenId: confidentialPrivateTokenId(asset), available: '42' }
      ],
      asset
    )
  ).toBe('42')
  expect(
    getConfidentialAvailableForAsset(
      [{ tokenId: `imt:${'a'.repeat(64)}:${asset}`, available: '9000' }],
      asset
    )
  ).toBeNull()
})

test('removes retired cached Shield balances from every projection without changing on-chain funds', () => {
  const legacyId = 'nep245:v2_1.omni.hot.tg:56_11111111111111111111'
  const currentId = 'nep141:bnb.omdep.near'
  const assetId = 'eip155:56/slip44:714'
  const holding = {
    tokenId: confidentialPrivateTokenId(legacyId),
    protocolAssetId: legacyId,
    assetId,
    chainId: 'eip155:56',
    symbol: 'BNB',
    decimals: 18,
    availableRaw: '25'
  }
  const asset = {
    asset: { id: assetId },
    balance: {
      totalRaw: '175',
      mainRaw: '100',
      privateRaw: '75',
      privateOnchainRaw: '50',
      confidentialRaw: '25',
      spendableRaw: '150',
      availableRaw: '150'
    }
  }
  const model = {
    assets: [asset],
    chains: [{ assets: [asset] }],
    confidential: { status: 'ready', assets: [holding] }
  }
  const filtered = excludeDeprecatedConfidentialAssets(model)
  expect(filtered.confidential.assets).toEqual([])
  expect(filtered.assets[0].balance).toEqual({
    ...asset.balance,
    totalRaw: '150',
    privateRaw: '50',
    confidentialRaw: '0'
  })
  expect(filtered.chains[0].assets[0]).toBe(filtered.assets[0])
  expect(excludeDeprecatedConfidentialAssets(filtered)).toBe(filtered)
  expect(model.assets[0].balance.totalRaw).toBe('175')
  expect(model.confidential.assets).toEqual([holding])

  const current = {
    ...holding,
    tokenId: confidentialPrivateTokenId(currentId),
    protocolAssetId: currentId,
    availableRaw: '7'
  }
  const both = excludeDeprecatedConfidentialAssets({
    ...model,
    confidential: { status: 'ready', assets: [holding, current] }
  })
  expect(both.confidential.assets).toEqual([current])
  expect(both.assets[0].balance).toMatchObject({
    totalRaw: '157',
    privateRaw: '57',
    confidentialRaw: '7',
    spendableRaw: '150'
  })
  expect(
    buildConfidentialPortfolioView(
      [{ tokenId: holding.tokenId, available: holding.availableRaw }],
      [],
      [],
      [],
      { get: () => undefined }
    ).assets
  ).toEqual([])
  expect(
    mergeConfidentialBalancesIntoPortfolio(
      model,
      [{ assetId, protocolAssetId: legacyId }],
      [{ tokenId: holding.tokenId, available: holding.availableRaw }]
    ).assets[0].balance.confidentialRaw
  ).toBe('0')
})

test('keeps Confidential balances out of directly spendable on-chain balances', () => {
  const asset = {
    asset: { id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111' },
    metadata: { decimals: 6, symbol: 'USDC' },
    source: 'bundled',
    balance: {
      totalRaw: '150',
      spendableRaw: '150',
      availableRaw: '150',
      pendingRaw: '0',
      mainRaw: '100',
      privateRaw: '50'
    },
    chainAccountIds: [],
    freshness: 'fresh',
    updatedAt: 1
  }
  const zcashAssetId = 'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133'
  const zcashAsset = {
    ...asset,
    asset: { id: zcashAssetId },
    metadata: { decimals: 8, symbol: 'ZEC' },
    balance: {
      totalRaw: '120',
      spendableRaw: '0',
      availableRaw: '0',
      pendingRaw: '0',
      transparentRaw: '80',
      shieldedRaw: '40'
    }
  }
  const model = {
    scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
    status: 'ready',
    assets: [asset, zcashAsset],
    chains: [
      { chain: { id: 'eip155:1' }, status: 'ready', assets: [asset], errorCodes: [] },
      {
        chain: { id: 'bip122:00040fe8ec8471911baa1db1266ea15d' },
        status: 'ready',
        assets: [zcashAsset],
        errorCodes: []
      }
    ],
    ignoredAssetCount: 0
  }
  const merged = mergeConfidentialBalancesIntoPortfolio(
    model,
    [
      { assetId: asset.asset.id, protocolAssetId: 'nep141:usdc.omft.near' },
      { assetId: zcashAssetId, protocolAssetId: 'nep141:zec.omft.near' }
    ],
    [
      { tokenId: 'nep141:usdc.omft.near', available: '25' },
      { tokenId: 'nep141:zec.omft.near', available: '40' }
    ]
  )
  expect(merged.assets[0].balance).toMatchObject({
    totalRaw: '175',
    spendableRaw: '150',
    availableRaw: '150',
    mainRaw: '100',
    privateRaw: '75',
    privateOnchainRaw: '50',
    confidentialRaw: '25'
  })
  expect(merged.assets[1].balance).toEqual(zcashAsset.balance)
})

test('only projects Confidential zero after a confirmed empty balance read', async () => {
  const asset = {
    asset: { id: 'eip155:1/erc20:0x1111111111111111111111111111111111111111' },
    metadata: { decimals: 6, symbol: 'USDC' },
    balance: { totalRaw: '150', mainRaw: '100', privateRaw: '50' }
  }
  const model = {
    scope: { keyDomainId: 'wallet:one', accountId: 'account:one' },
    assets: [asset],
    chains: [{ chain: { id: 'eip155:1' }, assets: [asset] }]
  }
  let snapshot = { fresh: false, balances: [] }
  let session = null
  let resolvedIdentity = false
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    store: {
      getBalanceSnapshot: async () => snapshot,
      getSession: async () => session,
      putBalances: async () => {}
    },
    api: {
      getBalances: async () => {
        throw new Error('balance service unavailable')
      }
    },
    signer: {
      resolveIdentity: async () => {
        resolvedIdentity = true
        return {
          context: {
            chainAccount: {
              scope: { keyDomainId: 'wallet:one', accountId: 'account:one' }
            }
          }
        }
      }
    },
    repository: {},
    assets: {},
    evmNetworks: [{ chainId: 'eip155:1', rpcUrl: 'https://rpc.example.test' }],
    assetMappings: [{ assetId: asset.asset.id, protocolAssetId: 'nep141:usdc.omft.near' }],
    now: () => 1000
  })

  expect((await coordinator.enrichPortfolio(model)).confidential).toEqual({
    status: 'unavailable',
    assets: []
  })
  expect(resolvedIdentity).toBe(false)

  session = { accessToken: 'session', expiresAt: 1_000_000_000, refreshExpiresAt: 2_000_000_000 }
  expect((await coordinator.enrichPortfolio(model, false)).confidential).toEqual({
    status: 'unavailable',
    assets: []
  })
  expect(resolvedIdentity).toBe(false)
  expect((await coordinator.enrichPortfolio(model)).confidential).toEqual({
    status: 'unavailable',
    assets: []
  })
  expect(resolvedIdentity).toBe(true)

  snapshot = { fresh: true, balances: [] }
  const knownZero = await coordinator.enrichPortfolio(model)
  expect(knownZero.assets[0].balance).toMatchObject({
    totalRaw: '150',
    privateRaw: '50',
    privateOnchainRaw: '50',
    confidentialRaw: '0'
  })
  expect(knownZero.confidential).toEqual({ status: 'ready', assets: [] })
})
