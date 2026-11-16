import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  normalizePrivateBalanceTransferInput,
  resolvePrivateBalanceTransferAmount,
  selectDefaultTransferAssetId
} from '../../../src/popup/services/private-balance-transfer.ts'
import { createInitialProductChainRegistry } from '../../../src/core/chains/registry/index.ts'
import { ZCASH_CHAIN_IDS } from '../../../src/core/chains/registry/chain-ids.ts'
import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'
import { resolveManagedIntentsAssets } from '../../../src/core/services/intents-managed-assets.ts'
import {
  buildExternalShieldWithdrawRequest,
  buildShieldTransferRequest,
  listShieldFundingAssets,
  listShieldMoveDestinations,
  listShieldSendDestinations,
  selectDefaultShieldWithdrawSource,
  selectShieldWithdrawDestinationForNetwork,
  shieldFundingSources,
  shieldPortfolioBalances
} from '../../../src/popup/services/shield-transfer.ts'
import {
  buildShieldSwapRequest,
  buildShieldSwapPreviewRequest
} from '../../../src/popup/services/shield-swap-form.ts'
import { initialMoveDraft } from '../../../src/popup/pages/transactions/move-draft.ts'
import {
  readShieldMovePreference,
  selectShieldMoveAssetId,
  shieldMovePreferenceKey
} from '../../../src/popup/pages/transactions/move-preference.ts'

test('restores a Move draft only for its wallet account and network', () => {
  const scope = 'mainnet:wallet-1:account-1:rpc-1'
  const draft = {
    scope,
    assetId: 'eip155:8453/slip44:60',
    from: 'private',
    to: 'public',
    amount: '0.00001',
    method: 'directly',
    maxSelected: false
  }
  const input = {
    state: { moveDraft: draft },
    mode: 'private',
    routeFrom: null,
    routeTo: null,
    routeAssetId: null
  }

  expect(initialMoveDraft({ ...input, scope })).toEqual(draft)
  for (const otherScope of [
    'mainnet:wallet-1:account-2:rpc-1',
    'testnet:wallet-1:account-1:rpc-1'
  ]) {
    expect(initialMoveDraft({ ...input, scope: otherScope })).toMatchObject({
      assetId: null,
      amount: '',
      maxSelected: false
    })
  }
})

test('defaults Shield Move and keeps preferences scoped to a supported account asset', () => {
  const scope = 'mainnet:wallet-1:account-1:rpc-1'
  expect(
    initialMoveDraft({
      state: null,
      scope,
      mode: 'private',
      routeFrom: null,
      routeTo: null,
      routeAssetId: null
    })
  ).toMatchObject({ from: 'private', to: 'shield', assetId: null, amount: '' })
  expect(
    initialMoveDraft({
      state: null,
      scope,
      mode: 'public',
      routeFrom: null,
      routeTo: null,
      routeAssetId: null,
      entry: 'shield'
    })
  ).toMatchObject({ from: 'public', to: 'shield', assetId: null, amount: '' })
  expect(
    initialMoveDraft({
      state: null,
      scope,
      mode: 'private',
      routeFrom: null,
      routeTo: null,
      routeAssetId: null,
      entry: 'shield'
    })
  ).toMatchObject({ from: 'private', to: 'shield', assetId: null, amount: '' })
  expect(
    initialMoveDraft({
      state: null,
      scope,
      mode: 'private',
      routeFrom: 'shield',
      routeTo: 'public',
      routeAssetId: 'eip155:1/slip44:60',
      entry: 'asset-detail'
    })
  ).toMatchObject({ from: 'shield', to: 'public', assetId: 'eip155:1/slip44:60' })
  expect(shieldMovePreferenceKey('mainnet', 'wallet-1', 'account-1')).not.toBe(
    shieldMovePreferenceKey('testnet', 'wallet-1', 'account-1')
  )
  expect(shieldMovePreferenceKey('mainnet', 'wallet-1', 'account-1')).not.toBe(
    shieldMovePreferenceKey('mainnet', 'wallet-1', 'account-2')
  )
  expect(
    readShieldMovePreference({
      provider: 'near-confidential',
      assetId: 'eip155:1/slip44:60',
      destinationAssetId: null,
      from: 'public',
      to: 'public'
    })
  ).toBeNull()
})

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
  expect(selectShieldWithdrawDestinationForNetwork(options, baseUsdc, 'eip155:137')).toBeNull()
})

test('defaults Shield withdrawal to the highest USD balance or Ethereum USDC when empty', () => {
  const usdcContract = getEvmNetworkConfigs('mainnet')
    .find(config => config.chainId === 'eip155:1')
    .usdcContract.toLowerCase()
  const option = (chainId, reference, protocolAssetId, decimals) => ({
    chain: { chain: { id: chainId } },
    asset: {
      asset: { id: `${chainId}/erc20:${reference}`, chainId, namespace: 'erc20', reference },
      metadata: { decimals }
    },
    managed: { protocolAssetId }
  })
  const baseUsdc = option('eip155:8453', `0x${'1'.repeat(40)}`, 'base-usdc', 6)
  const ethereumUsdc = option('eip155:1', usdcContract, 'ethereum-usdc', 6)
  const ethereumOther = option('eip155:1', `0x${'2'.repeat(40)}`, 'other', 18)
  const options = [baseUsdc, ethereumOther, ethereumUsdc]
  const balances = [
    { tokenId: 'base-usdc', available: '10000000' },
    { tokenId: 'other', available: '1000000000000000000' },
    { tokenId: 'ethereum-usdc', available: '2000000' }
  ]
  const model = {
    confidential: {
      status: 'ready',
      assets: [
        { protocolAssetId: 'base-usdc', availableRaw: '10000000', priceUsd: '1' },
        { protocolAssetId: 'other', availableRaw: '1000000000000000000', priceUsd: '20' },
        { protocolAssetId: 'ethereum-usdc', availableRaw: '2000000', priceUsd: '1' }
      ]
    }
  }

  expect(selectDefaultShieldWithdrawSource(options, balances, model, null, 'mainnet')).toBe(
    ethereumOther
  )
  expect(
    selectDefaultShieldWithdrawSource(
      options,
      balances,
      model,
      {
        quotes: [{ assetId: ethereumUsdc.asset.asset.id, priceUsd: '15' }]
      },
      'mainnet'
    )
  ).toBe(ethereumUsdc)
  expect(selectDefaultShieldWithdrawSource(options, balances, null, null, 'mainnet')).toBe(baseUsdc)
  expect(
    selectDefaultShieldWithdrawSource(
      options,
      balances.map(balance => ({ ...balance, available: '0' })),
      model,
      null,
      'mainnet'
    )
  ).toBe(ethereumUsdc)
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
  const publicProjection = {
    ...sources[0],
    asset: {
      ...sources[0].asset,
      balance: { ...sources[0].asset.balance, confidentialRaw: undefined }
    }
  }
  expect(
    selectShieldMoveAssetId({
      assets: [publicProjection],
      eligibleChainIds: ['eip155:1'],
      managedAssets: managed,
      catalogTokens: tokens,
      network: 'mainnet',
      from: 'shield',
      shieldBalances: balances,
      preferredAssetId: sourceId
    })
  ).toBe(sourceId)
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
  const unfundedSwap = {
    network: 'mainnet',
    keyDomainId: 'wallet',
    accountId: 'account',
    from: sources[0],
    to: options.find(item => item.asset.asset.id === destinationId),
    amount: '1.25',
    balances: [],
    slippageBps: 50
  }
  expect(buildShieldSwapPreviewRequest(unfundedSwap).source.amountRaw).toBe('1250000')
  expect(() => buildShieldSwapRequest(unfundedSwap)).toThrow('Shield swap is unavailable')
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
  const zcashRecipient = 't1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F'
  expect(
    listShieldSendDestinations(zcashSource, withZcashOptions, 'mainnet').map(
      item => item.asset.asset.id
    )
  ).toContain(zcashAssetId)
  expect(
    buildExternalShieldWithdrawRequest({
      network: 'mainnet',
      keyDomainId: 'wallet',
      accountId: 'account',
      amountRaw: '100000',
      recipient: zcashRecipient,
      source: zcashSource,
      destination: zcashSource,
      slippageBps: 50
    })
  ).toMatchObject({
    destination: { chainId: ZCASH_CHAIN_IDS.mainnet, protocolAssetId: zcashProtocolId },
    externalRecipient: zcashRecipient
  })
  expect(() =>
    buildExternalShieldWithdrawRequest({
      network: 'mainnet',
      keyDomainId: 'wallet',
      accountId: 'account',
      amountRaw: '100000',
      recipient: `0x${'3'.repeat(40)}`,
      source: zcashSource,
      destination: zcashSource,
      slippageBps: 50
    })
  ).toThrow('Shield withdrawal is unavailable')
  expect(() =>
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
  ).toThrow('Shield withdrawal is unavailable')
})

test('binds a Shield ETH Move to the selected EVM destination asset', () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const ethereum = chains.resolve('eip155:1')
  const base = chains.resolve('eip155:8453')
  const fakeAssetId = `eip155:8453/erc20:0x${'a'.repeat(40)}`
  const fakeProtocolId = 'nep141:fake-eth.omft.near'
  const model = {
    chains: [ethereum, base].map(chain => ({ chain, status: 'ready', assets: [], errorCodes: [] })),
    assets: [],
    confidential: {
      status: 'ready',
      assets: [
        {
          tokenId: 'nep141:eth.omft.near',
          protocolAssetId: 'nep141:eth.omft.near',
          availableRaw: '1000000000000000000'
        }
      ]
    }
  }
  const managed = [
    {
      assetId: fakeAssetId,
      chainId: 'eip155:8453',
      protocolAssetId: fakeProtocolId,
      blockchain: 'base',
      symbol: 'ETH',
      decimals: 18,
      management: 'evm'
    }
  ]
  const tokens = [
    { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18 },
    { assetId: 'nep141:base.omft.near', blockchain: 'base', symbol: 'ETH', decimals: 18 },
    { assetId: fakeProtocolId, blockchain: 'base', symbol: 'ETH', decimals: 18 }
  ]
  const options = listShieldFundingAssets(model, managed, tokens, 'mainnet')
  const source = options.find(item => item.asset.asset.id === 'eip155:1/slip44:60')
  const destination = options.find(item => item.asset.asset.id === 'eip155:8453/slip44:60')
  expect(source).toBeDefined()
  expect(destination).toBeDefined()
  expect(
    listShieldMoveDestinations(source, options, 'mainnet').map(item => item.asset.asset.id)
  ).toEqual([source.asset.asset.id, destination.asset.asset.id])
  expect(destination.asset.metadata.decimals).toBe(18)

  const input = {
    network: 'mainnet',
    keyDomainId: 'wallet',
    accountId: 'account',
    from: 'shield',
    to: 'private',
    method: 'directly',
    amountRaw: '1000000000000000000',
    asset: source.asset,
    chain: source.chain,
    managed: source.managed
  }
  expect(buildShieldTransferRequest({ ...input, destination })).toMatchObject({
    operation: 'withdraw',
    sourceDomain: 'shield',
    destinationDomain: 'private',
    source: {
      chainId: 'eip155:1',
      assetId: 'eip155:1/slip44:60',
      protocolAssetId: 'nep141:eth.omft.near',
      amountRaw: '1000000000000000000'
    },
    destination: {
      chainId: 'eip155:8453',
      assetId: 'eip155:8453/slip44:60',
      protocolAssetId: 'nep141:base.omft.near'
    }
  })
  expect(buildShieldTransferRequest(input).destination).toEqual({
    chainId: 'eip155:1',
    chainName: 'eth',
    assetId: 'eip155:1/slip44:60',
    protocolAssetId: 'nep141:eth.omft.near'
  })
  const fake = options.find(item => item.asset.asset.id === fakeAssetId)
  expect(fake).toBeDefined()
  const sendInput = {
    network: 'mainnet',
    keyDomainId: 'wallet',
    accountId: 'account',
    amountRaw: input.amountRaw,
    recipient: `0x${'3'.repeat(40)}`,
    source,
    destination,
    slippageBps: 50
  }
  expect(buildExternalShieldWithdrawRequest(sendInput)).toMatchObject({
    operation: 'withdraw',
    externalRecipient: sendInput.recipient,
    source: { assetId: source.asset.asset.id, amountRaw: input.amountRaw },
    destination: { assetId: destination.asset.asset.id }
  })
  expect(buildExternalShieldWithdrawRequest({ ...sendInput, destination: source })).toMatchObject({
    destination: { assetId: source.asset.asset.id }
  })
  expect(() => buildExternalShieldWithdrawRequest({ ...sendInput, destination: fake })).toThrow(
    'Shield withdrawal is unavailable'
  )
  expect(() => buildShieldTransferRequest({ ...input, destination: fake })).toThrow(
    'Shield transfer is unavailable'
  )
  expect(() => buildShieldTransferRequest({ ...input, method: 'cluster', destination })).toThrow(
    'Shield transfer is unavailable'
  )
  expect(() => buildShieldTransferRequest({ ...input, method: 'cluster' })).toThrow(
    'Shield transfer is unavailable'
  )
})

test('lists official cross-network USDC destinations from the managed catalog', () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const sourceProtocolId = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'
  const destinationProtocolId = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
  const sourceAssetId = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  const destinationAssetId = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  const tokens = [
    {
      assetId: sourceProtocolId,
      blockchain: 'eth',
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      symbol: 'USDC',
      decimals: 6
    },
    {
      assetId: destinationProtocolId,
      blockchain: 'base',
      contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      symbol: 'USDC',
      decimals: 6
    }
  ]
  const managed = resolveManagedIntentsAssets(tokens, 'mainnet', getEvmNetworkConfigs('mainnet'))
  const model = {
    chains: ['eip155:1', 'eip155:8453'].map(id => ({
      chain: chains.resolve(id),
      status: 'ready',
      assets: [],
      errorCodes: []
    })),
    assets: [],
    confidential: {
      status: 'ready',
      assets: [
        { tokenId: sourceProtocolId, protocolAssetId: sourceProtocolId, availableRaw: '20000' }
      ]
    }
  }
  const options = listShieldFundingAssets(model, managed, tokens, 'mainnet')
  const moveAssets = options.map(({ asset, chain }) => ({ asset, chain }))
  const selectMoveAsset = (eligibleChainIds, preferredAssetId = null, catalog = managed) =>
    selectShieldMoveAssetId({
      assets: moveAssets,
      eligibleChainIds,
      managedAssets: catalog,
      catalogTokens: tokens,
      network: 'mainnet',
      from: 'public',
      preferredAssetId
    })
  expect(selectMoveAsset(['eip155:1', 'eip155:8453'])).toBe(sourceAssetId)
  expect(selectMoveAsset(['eip155:1', 'eip155:8453'], destinationAssetId)).toBe(destinationAssetId)
  expect(selectMoveAsset(['eip155:1', 'eip155:8453'], 'eip155:10/slip44:60')).toBe(sourceAssetId)
  expect(selectMoveAsset(['eip155:8453'])).toBe(destinationAssetId)
  expect(selectMoveAsset(['eip155:1', 'eip155:8453'], null, [])).toBeNull()
  const fundedBase = moveAssets.map(item =>
    item.asset.asset.id === destinationAssetId
      ? {
          ...item,
          asset: {
            ...item.asset,
            balance: {
              ...item.asset.balance,
              totalRaw: '25000',
              mainRaw: '25000',
              privateRaw: '0'
            }
          }
        }
      : item
  )
  expect(
    selectShieldMoveAssetId({
      assets: fundedBase,
      eligibleChainIds: ['eip155:1', 'eip155:8453'],
      managedAssets: managed,
      catalogTokens: tokens,
      network: 'mainnet',
      from: 'public',
      preferredAssetId: sourceAssetId
    })
  ).toBe(destinationAssetId)
  const source = options.find(item => item.asset.asset.id === sourceAssetId)
  expect(source).toBeDefined()
  expect(
    listShieldMoveDestinations(source, options, 'mainnet').map(item => item.asset.asset.id)
  ).toEqual([sourceAssetId, destinationAssetId])
  const destination = options.find(item => item.asset.asset.id === destinationAssetId)
  expect(destination.asset.metadata.decimals).toBe(6)
  const currentBridge = {
    ...destination,
    managed: { ...destination.managed, protocolAssetId: 'nep245:current-bridge:base-usdc' }
  }
  expect(listShieldSendDestinations(source, [currentBridge], 'mainnet')).toEqual([currentBridge])
  expect(
    buildExternalShieldWithdrawRequest({
      network: 'mainnet',
      keyDomainId: 'wallet',
      accountId: 'account',
      source,
      destination: currentBridge,
      amountRaw: '10000',
      recipient: `0x${'3'.repeat(40)}`,
      slippageBps: 50
    }).destination.protocolAssetId
  ).toBe(currentBridge.managed.protocolAssetId)
  const bnbTokens = [
    ...tokens.map(token => ({ ...token, coingeckoId: 'usd-coin' })),
    {
      assetId: 'nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near',
      blockchain: 'bsc',
      contractAddress: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
      symbol: 'USDC',
      decimals: 18,
      coingeckoId: 'usd-coin'
    },
    {
      assetId: 'nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near',
      blockchain: 'bsc',
      contractAddress: '0x55d398326f99059ff775485246999027b3197955',
      symbol: 'USDT',
      decimals: 18,
      coingeckoId: 'tether'
    }
  ]
  const sendOptions = listShieldFundingAssets(
    {
      ...model,
      chains: [
        ...model.chains,
        { chain: chains.resolve('eip155:56'), status: 'ready', assets: [], errorCodes: [] }
      ]
    },
    resolveManagedIntentsAssets(bnbTokens, 'mainnet', getEvmNetworkConfigs('mainnet')),
    bnbTokens,
    'mainnet'
  )
  const sendSource = sendOptions.find(item => item.asset.asset.id === sourceAssetId)
  expect(
    listShieldSendDestinations(sendSource, sendOptions, 'mainnet').map(item => item.asset.asset.id)
  ).toEqual([
    sourceAssetId,
    destinationAssetId,
    'eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
  ])
  expect(
    buildShieldTransferRequest({
      network: 'mainnet',
      keyDomainId: 'wallet',
      accountId: 'account',
      from: 'shield',
      to: 'public',
      method: 'directly',
      amountRaw: '10000',
      asset: source.asset,
      chain: source.chain,
      managed: source.managed,
      destination
    })
  ).toMatchObject({
    source: { protocolAssetId: sourceProtocolId, amountRaw: '10000' },
    destination: { chainId: 'eip155:8453', protocolAssetId: destinationProtocolId }
  })
})
