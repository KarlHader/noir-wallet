import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  normalizePrivateBalanceTransferInput,
  resolvePrivateBalanceTransferAmount,
  selectDefaultTransferAssetId
} from '../../../src/popup/services/private-balance-transfer.ts'
import { createInitialProductChainRegistry } from '../../../src/core/chains/registry/index.ts'
import { ZCASH_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'
import {
  buildExternalShieldWithdrawRequest,
  listShieldFundingAssets,
  selectShieldWithdrawDestinationForNetwork,
  shieldFundingSources,
  shieldPortfolioBalances
} from '../../../src/popup/services/shield-transfer.ts'
import { buildShieldSwapRequest } from '../../../src/popup/services/shield-swap-form.ts'

test('validates a bidirectional transfer amount against the selected source balance', () => {
  expect(
    resolvePrivateBalanceTransferAmount({
      amount: '1.25',
      decimals: 6,
      availableRaw: '2500000',
      sourceLabel: 'Public'
    })
  ).toEqual({ amountRaw: '1250000', error: null })
  expect(
    resolvePrivateBalanceTransferAmount({
      amount: '3',
      decimals: 6,
      availableRaw: '2500000',
      sourceLabel: 'Confidential'
    })
  ).toEqual({ amountRaw: null, error: 'Amount exceeds the Confidential balance' })
})

test('keeps empty and incomplete amounts non-submittable without an error', () => {
  for (const amount of ['', '.', '0', '0.', '0.00']) {
    expect(
      resolvePrivateBalanceTransferAmount({
        amount,
        decimals: 6,
        availableRaw: '2500000',
        sourceLabel: 'Public'
      })
    ).toEqual({ amountRaw: null, error: null })
  }
})

test('rejects excess precision, exponent notation, and oversized input', () => {
  expect(
    resolvePrivateBalanceTransferAmount({
      amount: '0.0000001',
      decimals: 6,
      availableRaw: '2500000',
      sourceLabel: 'Public'
    }).error
  ).toBe('Enter a valid amount')
  expect(normalizePrivateBalanceTransferInput('1e3')).toBeNull()
  expect(normalizePrivateBalanceTransferInput('1'.repeat(129))).toBeNull()
})

test('keeps the selected Shield withdrawal token when choosing its network', () => {
  const option = (chainId, symbol) => ({
    chain: { chain: { id: chainId } },
    asset: {
      asset: { id: `${chainId}/${symbol}` },
      metadata: { symbol, name: symbol }
    }
  })
  const baseUsdc = option('eip155:8453', 'USDC')
  const baseEth = option('eip155:8453', 'ETH')
  const arbitrumUsdc = option('eip155:42161', 'USDC')
  const polygonEth = option('eip155:137', 'ETH')
  const options = [baseUsdc, baseEth, arbitrumUsdc, polygonEth]

  expect(selectShieldWithdrawDestinationForNetwork(options, baseUsdc, 'eip155:8453')).toBe(baseUsdc)
  expect(selectShieldWithdrawDestinationForNetwork(options, baseUsdc, 'eip155:42161')).toBe(
    arbitrumUsdc
  )
  expect(selectShieldWithdrawDestinationForNetwork(options, baseUsdc, 'eip155:137')).toBe(
    polygonEth
  )
})

test('uses independently held Shield tokens without adding them to Public assets', () => {
  const chain = createInitialProductChainRegistry('mainnet').resolve('eip155:1')
  const sourceId = `eip155:1/erc20:0x${'1'.repeat(40)}`
  const destinationId = `eip155:1/erc20:0x${'2'.repeat(40)}`
  const sourceProtocolId = 'nep141:trial.omft.near'
  const destinationProtocolId = 'nep141:other.omft.near'
  const managed = [
    {
      assetId: sourceId,
      chainId: 'eip155:1',
      protocolAssetId: sourceProtocolId,
      namespace: 'erc20',
      reference: `0x${'1'.repeat(40)}`,
      blockchain: 'eth',
      symbol: 'TRIAL',
      decimals: 6,
      management: 'evm'
    },
    {
      assetId: destinationId,
      chainId: 'eip155:1',
      protocolAssetId: destinationProtocolId,
      namespace: 'erc20',
      reference: `0x${'2'.repeat(40)}`,
      blockchain: 'eth',
      symbol: 'OTHER',
      decimals: 18,
      management: 'evm'
    }
  ]
  const tokens = managed.map(asset => ({
    assetId: asset.protocolAssetId,
    blockchain: asset.blockchain,
    symbol: asset.symbol,
    decimals: asset.decimals
  }))
  const model = {
    scope: { keyDomainId: 'wallet', accountId: 'account' },
    status: 'ready',
    chains: [{ chain, status: 'ready', assets: [], errorCodes: [] }],
    assets: [],
    ignoredAssetCount: 0,
    confidential: {
      status: 'ready',
      assets: [
        {
          tokenId: sourceProtocolId,
          protocolAssetId: sourceProtocolId,
          availableRaw: '1500000',
          assetId: sourceId,
          chainId: 'eip155:1',
          decimals: 6
        }
      ]
    }
  }
  const options = listShieldFundingAssets(model, managed, tokens, 'mainnet')
  const balances = shieldPortfolioBalances(model)
  const sources = shieldFundingSources(options, balances)
  expect(model.assets).toHaveLength(0)
  expect(sources.map(item => item.asset.asset.id)).toEqual([sourceId])
  const zcash = {
    chain: { chain: { id: ZCASH_CHAIN_IDS.mainnet, family: 'zcash' } },
    asset: {
      asset: { id: `${ZCASH_CHAIN_IDS.mainnet}/slip44:133`, chainId: ZCASH_CHAIN_IDS.mainnet },
      balance: { totalRaw: '100000000', transparentRaw: '0', shieldedRaw: '100000000' }
    }
  }
  const move = { from: 'shield', to: 'private', eligibleChainIds: ['eip155:1'] }
  expect(selectDefaultTransferAssetId({ ...move, assets: [zcash, ...sources] })).toBe(sourceId)
  expect(selectDefaultTransferAssetId({ ...move, assets: [zcash] })).toBeNull()
  expect(
    selectDefaultTransferAssetId({ ...move, assets: sources, eligibleChainIds: [] })
  ).toBeNull()
  expect(options.map(item => item.asset.asset.id)).toContain(destinationId)
  expect(
    buildShieldSwapRequest({
      network: 'mainnet',
      keyDomainId: 'wallet',
      accountId: 'account',
      from: sources[0],
      to: options.find(item => item.asset.asset.id === destinationId),
      amount: '1.25',
      balances,
      slippageBps: 50
    })
  ).toMatchObject({
    source: { assetId: sourceId, protocolAssetId: sourceProtocolId, amountRaw: '1250000' },
    destination: { assetId: destinationId, protocolAssetId: destinationProtocolId }
  })
  expect(
    listShieldFundingAssets(
      {
        ...model,
        confidential: {
          ...model.confidential,
          assets: [{ ...model.confidential.assets[0], decimals: 18 }]
        }
      },
      managed,
      tokens,
      'mainnet'
    ).map(item => item.asset.asset.id)
  ).not.toContain(sourceId)

  const zcashAssetId = `${ZCASH_CHAIN_IDS.mainnet}/slip44:133`
  const zcashProtocolId = 'nep141:zec.omft.near'
  const withZcash = {
    ...model,
    confidential: {
      status: 'ready',
      assets: [
        ...model.confidential.assets,
        { tokenId: zcashProtocolId, protocolAssetId: zcashProtocolId, availableRaw: '140000' }
      ]
    }
  }
  const withZcashOptions = listShieldFundingAssets(
    withZcash,
    managed,
    [...tokens, { assetId: zcashProtocolId, blockchain: 'zec', symbol: 'ZEC', decimals: 8 }],
    'mainnet'
  )
  const zcashSource = shieldFundingSources(
    withZcashOptions,
    shieldPortfolioBalances(withZcash)
  ).find(item => item.asset.asset.id === zcashAssetId)
  expect(zcashSource?.asset.balance.confidentialRaw).toBe('140000')
  expect(
    buildExternalShieldWithdrawRequest({
      network: 'mainnet',
      keyDomainId: 'wallet',
      accountId: 'account',
      amountRaw: '100000',
      recipient: `0x${'3'.repeat(40)}`,
      source: zcashSource,
      destination: withZcashOptions.find(item => item.asset.asset.id === destinationId),
      slippageBps: 50
    })
  ).toMatchObject({
    source: { assetId: zcashAssetId, protocolAssetId: zcashProtocolId, amountRaw: '100000' },
    destination: { chainId: 'eip155:1', protocolAssetId: destinationProtocolId }
  })
})
