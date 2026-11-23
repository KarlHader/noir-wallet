import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getCrossChainSendAssetGroup,
  getCrossChainSendDestinationAssetId,
  getCrossChainSendRouteCost,
  getCrossChainSendTokenGroup,
  getCrossChainSendWalletAssetId,
  isCrossChainSendDestination,
  isCrossChainSendRecipientValid,
  resolveCrossChainSendDestinationByWalletAssetId,
  resolveCrossChainSendDestinationSupport,
  resolveCrossChainSendRouteAssetDisplay,
  resolveCrossChainSendDraft
} from '../../../src/popup/services/cross-chain-send-assets.ts'
import { getSwapDestinationTokens } from '../../../src/popup/services/swap-token-selection.ts'
import { MARKET_ASSETS } from '../../../src/config/asset-market-assets.ts'

const eth = {
  assetId: 'nep141:eth.omft.near',
  blockchain: 'eth',
  contractAddress: null,
  decimals: 18,
  icon: null,
  price: 0,
  priceUpdatedAt: '',
  symbol: 'ETH',
  rheaChainId: '1',
  tokenListChainId: 1,
  rheaAddress: '0x0000000000000000000000000000000000000000',
  isNative: true
}
const enabledChains = { evm: true, solana: true }

test('cross-chain Send keeps the selected network draft bound to its source account', () => {
  const draft = {
    walletId: 'wallet-1',
    accountId: 'account-1',
    sourceAssetId: 'eip155:42161/slip44:60',
    destinationAssetId: 'eip155:1/slip44:60',
    destinationChainId: 'eip155:1',
    recipient: '0x1111111111111111111111111111111111111111',
    amount: '0.000001'
  }
  const active = {
    network: 'mainnet',
    walletId: draft.walletId,
    accountId: draft.accountId,
    draft
  }
  for (const destinationAssetId of [draft.destinationAssetId, null, 'eip155:1/slip44:0']) {
    expect(
      resolveCrossChainSendDraft({ ...active, draft: { ...draft, destinationAssetId } })
    ).toMatchObject({
      recipient: draft.recipient,
      amount: draft.amount,
      sourceSymbol: 'ETH',
      destinationName: 'Ethereum'
    })
  }
  for (const scope of [
    { walletId: 'wallet-2' },
    { accountId: 'account-2' },
    { walletId: null, accountId: null },
    { network: 'testnet' }
  ]) {
    expect(resolveCrossChainSendDraft({ ...active, ...scope })).toBeNull()
  }
  expect(
    resolveCrossChainSendDraft({
      ...active,
      draft: { ...draft, destinationAssetId: null, destinationChainId: 'eip155:999999' }
    })
  ).toBeNull()
  expect(
    resolveCrossChainSendDraft({
      ...active,
      draft: { ...draft, destinationChainId: 'eip155:8453' }
    })
  ).toBeNull()
  expect(
    resolveCrossChainSendRouteAssetDisplay({ network: active.network, ...draft })
  ).toMatchObject({
    sourceSymbol: 'ETH',
    destinationName: 'Ethereum'
  })
})

test('cross-chain Send uses verified asset identities and excludes the source network', () => {
  const baseEth = {
    ...eth,
    assetId: 'nep141:base.omft.near',
    rheaChainId: '8453',
    tokenListChainId: 8453,
    blockchain: 'base'
  }
  expect(isCrossChainSendDestination(eth, baseEth, enabledChains)).toBe(true)
  expect(isCrossChainSendDestination(eth, eth, enabledChains)).toBe(false)
  expect(isCrossChainSendDestination(eth, { ...baseEth, isNative: false }, enabledChains)).toBe(
    false
  )
  expect(
    resolveCrossChainSendDestinationByWalletAssetId(
      eth,
      'eip155:8453/slip44:60',
      [eth, baseEth],
      enabledChains
    )
  ).toBe(baseEth)
  expect(
    resolveCrossChainSendDestinationByWalletAssetId(
      eth,
      'eip155:1/slip44:60',
      [eth, baseEth],
      enabledChains
    )
  ).toBeNull()
  expect(
    getCrossChainSendAssetGroup({
      chainId: 'eip155:8453',
      namespace: 'slip44',
      reference: '60'
    })
  ).toBe(MARKET_ASSETS.eth)
  expect(
    getCrossChainSendAssetGroup({
      chainId: 'eip155:8453',
      namespace: 'erc20',
      reference: '0x0000000000000000000000000000000000000001'
    })
  ).toBe(null)
  expect(getCrossChainSendDestinationAssetId('eip155:8453', MARKET_ASSETS.eth)).toBe(
    'eip155:8453/slip44:60'
  )

  const arbitrumEth = {
    ...eth,
    assetId: 'nep141:arb.omft.near',
    blockchain: 'arb',
    rheaChainId: '42161',
    tokenListChainId: 42161
  }
  const aliasEth = { ...eth, rheaAddress: 'eth', sources: [] }
  const quoteEth = { ...eth, sources: ['nearintents'] }
  const canonicalDestinations = getSwapDestinationTokens(
    arbitrumEth,
    [arbitrumEth],
    [aliasEth, quoteEth]
  )
  const routeDestination = resolveCrossChainSendDestinationByWalletAssetId(
    arbitrumEth,
    'eip155:1/slip44:60',
    canonicalDestinations,
    enabledChains
  )
  expect(routeDestination).toBe(quoteEth)
  expect(canonicalDestinations).toContain(routeDestination)
  expect(getCrossChainSendWalletAssetId(routeDestination)).toBe('eip155:1/slip44:60')
  expect(getCrossChainSendWalletAssetId(baseEth)).toBe('eip155:8453/slip44:60')
  expect(getCrossChainSendWalletAssetId({ ...baseEth, isNative: false })).toBeNull()
  expect(
    getCrossChainSendRouteCost({
      source: arbitrumEth,
      destination: eth,
      amountInRaw: '100000000000000',
      estimatedOutRaw: '77630000000000'
    })
  ).toBe('0.00002237')
  expect(
    getCrossChainSendRouteCost({
      source: arbitrumEth,
      destination: eth,
      amountInRaw: '100000000000000',
      estimatedOutRaw: '100073653903600'
    })
  ).toBe('0')
})

test('Send network availability uses canonical identities and keeps missing or failed catalogs unknown', () => {
  const sourceAssetId = 'eip155:1/slip44:60'
  expect(
    resolveCrossChainSendDestinationSupport({
      sourceAssetId,
      destinationChainId: 'eip155:8453'
    })
  ).toEqual({ status: 'available', destinationAssetId: 'eip155:8453/slip44:60' })
  expect(
    resolveCrossChainSendDestinationSupport({
      sourceAssetId,
      destinationChainId: 'eip155:56'
    })
  ).toMatchObject({ status: 'unavailable', destinationAssetId: null })
  const custom = {
    ...eth,
    assetId: 'nep141:custom.token',
    isNative: false,
    contractAddress: `0x${'ab'.repeat(20)}`,
    rheaAddress: `0x${'ab'.repeat(20)}`
  }
  const target = {
    ...custom,
    rheaChainId: '8453',
    tokenListChainId: 8453,
    blockchain: 'base',
    contractAddress: `0x${'cd'.repeat(20)}`,
    rheaAddress: `0x${'cd'.repeat(20)}`
  }
  const request = {
    sourceAssetId: `eip155:1/erc20:${custom.contractAddress}`,
    destinationChainId: 'eip155:8453',
    sourceCatalog: { tokens: [custom], failedChainIds: [] }
  }
  for (const destinationCatalog of [
    null,
    { tokens: [], failedChainIds: [] },
    { tokens: [target], failedChainIds: [8453] }
  ]) {
    expect(resolveCrossChainSendDestinationSupport({ ...request, destinationCatalog }).status).toBe(
      'unknown'
    )
  }
  expect(
    resolveCrossChainSendDestinationSupport({
      ...request,
      destinationCatalog: { tokens: [target], failedChainIds: [] }
    })
  ).toEqual({
    status: 'available',
    destinationAssetId: `eip155:8453/erc20:${target.contractAddress}`
  })
  expect(
    resolveCrossChainSendDestinationSupport({
      ...request,
      destinationCatalog: {
        tokens: [{ ...target, assetId: 'nep141:other.token' }],
        failedChainIds: []
      }
    }).status
  ).toBe('unavailable')
  expect(
    resolveCrossChainSendDestinationSupport({
      ...request,
      sourceCatalog: { tokens: [custom], failedChainIds: [1] },
      destinationCatalog: { tokens: [target], failedChainIds: [] }
    }).status
  ).toBe('unknown')
  expect(
    resolveCrossChainSendDestinationSupport({
      ...request,
      sourceAssetId,
      destinationChainId: 'eip155:1'
    })
  ).toEqual({ status: 'available', destinationAssetId: sourceAssetId })
})

test('cross-chain Send accepts canonical USDC and rejects same-symbol tokens', () => {
  const usdc = {
    ...eth,
    assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    rheaChainId: '8453',
    tokenListChainId: 8453,
    blockchain: 'base',
    symbol: 'USDC',
    isNative: false,
    contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    rheaAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  }
  const solanaUsdc = {
    ...usdc,
    assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    rheaChainId: 'solana',
    tokenListChainId: 501,
    blockchain: 'sol',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    rheaAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  }
  const ethereumUsdc = {
    ...usdc,
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    rheaChainId: '1',
    tokenListChainId: 1,
    blockchain: 'eth',
    contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    rheaAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  }
  expect(
    getCrossChainSendRouteCost({
      source: { ...ethereumUsdc, decimals: 6 },
      destination: { ...usdc, decimals: 18 },
      amountInRaw: '2000000',
      estimatedOutRaw: '1979000000000000000'
    })
  ).toBe('0.021')
  expect(
    getCrossChainSendRouteCost({
      source: { ...ethereumUsdc, decimals: 6 },
      destination: { ...usdc, decimals: 18 },
      amountInRaw: '2000000',
      estimatedOutRaw: '2001000000000000000'
    })
  ).toBe('0')
  expect(
    getCrossChainSendRouteCost({
      source: ethereumUsdc,
      destination: eth,
      amountInRaw: '2000000',
      estimatedOutRaw: '1979000'
    })
  ).toBeNull()
  expect(
    getCrossChainSendRouteCost({
      source: ethereumUsdc,
      destination: usdc,
      amountInRaw: 'invalid',
      estimatedOutRaw: '1979000'
    })
  ).toBeNull()
  const polygonUsdc = {
    ...usdc,
    assetId: 'nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L',
    rheaChainId: '137',
    tokenListChainId: 137,
    blockchain: 'polygon',
    contractAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    rheaAddress: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
  }
  expect(
    resolveCrossChainSendDestinationByWalletAssetId(
      ethereumUsdc,
      getCrossChainSendDestinationAssetId('eip155:137', MARKET_ASSETS.usdc),
      [polygonUsdc],
      enabledChains
    )
  ).toBe(polygonUsdc)
  expect(isCrossChainSendDestination(usdc, solanaUsdc, enabledChains)).toBe(true)
  expect(
    resolveCrossChainSendDestinationByWalletAssetId(
      usdc,
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      [solanaUsdc],
      enabledChains
    )
  ).toBe(solanaUsdc)
  expect(
    resolveCrossChainSendDestinationByWalletAssetId(
      usdc,
      'eip155:8453/erc20:0x0000000000000000000000000000000000000001',
      [usdc],
      enabledChains
    )
  ).toBeNull()
  expect(isCrossChainSendDestination(usdc, solanaUsdc, { evm: true, solana: false })).toBe(false)
  expect(
    isCrossChainSendDestination(usdc, { ...solanaUsdc, rheaAddress: 'fake' }, enabledChains)
  ).toBe(false)
  expect(
    getCrossChainSendAssetGroup({
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      namespace: 'token',
      reference: solanaUsdc.rheaAddress
    })
  ).toBe(MARKET_ASSETS.usdc)
  expect(isCrossChainSendRecipientValid(solanaUsdc, solanaUsdc.rheaAddress)).toBe(true)
  expect(isCrossChainSendRecipientValid(solanaUsdc, 'invalid')).toBe(false)
  expect(isCrossChainSendRecipientValid(usdc, `0x${'12'.repeat(20)}`)).toBe(true)
  expect(isCrossChainSendRecipientValid(usdc, '0x1234')).toBe(false)
  expect(
    getCrossChainSendDestinationAssetId(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      MARKET_ASSETS.usdc
    )
  ).toBe(
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  )
  expect(getCrossChainSendWalletAssetId(solanaUsdc)).toBe(
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  )
})

test('cross-chain Send identifies official USDT0 contracts without trusting a matching symbol', () => {
  const polygon = {
    ...eth,
    assetId: 'nep141:polygon-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omft.near',
    blockchain: 'pol',
    rheaChainId: '137',
    tokenListChainId: 137,
    symbol: 'USDT0',
    decimals: 6,
    isNative: false,
    contractAddress: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    rheaAddress: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f'
  }
  const ethereum = {
    ...polygon,
    assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
    blockchain: 'eth',
    rheaChainId: '1',
    tokenListChainId: 1,
    contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    rheaAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7'
  }
  const arbitrum = {
    ...polygon,
    assetId: 'nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near',
    blockchain: 'arb',
    rheaChainId: '42161',
    tokenListChainId: 42161,
    contractAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    rheaAddress: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
  }
  const counterfeit = {
    ...ethereum,
    assetId: 'nep141:eth-0x1111111111111111111111111111111111111111.omft.near',
    contractAddress: '0x1111111111111111111111111111111111111111',
    rheaAddress: '0x1111111111111111111111111111111111111111'
  }
  expect(getCrossChainSendTokenGroup(polygon)).toBe('protocol:usdt0')
  expect(isCrossChainSendDestination(polygon, ethereum, enabledChains)).toBe(true)
  expect(isCrossChainSendDestination(polygon, arbitrum, enabledChains)).toBe(true)
  expect(isCrossChainSendDestination(polygon, counterfeit, enabledChains)).toBe(false)
  expect(
    resolveCrossChainSendDestinationSupport({
      sourceAssetId: getCrossChainSendWalletAssetId(polygon),
      destinationChainId: 'eip155:1'
    })
  ).toEqual({
    status: 'available',
    destinationAssetId: getCrossChainSendWalletAssetId(ethereum)
  })
  expect(
    resolveCrossChainSendDestinationSupport({
      sourceAssetId: getCrossChainSendWalletAssetId(polygon),
      destinationChainId: 'eip155:8453'
    }).status
  ).toBe('unavailable')
})

test('cross-chain Send resolves verified native and provider identities without matching symbols', () => {
  const bnb = {
    ...eth,
    assetId: 'nep141:bnb.omdep.near',
    blockchain: 'bsc',
    rheaChainId: '56',
    tokenListChainId: 56,
    symbol: 'BNB'
  }
  const baseEth = {
    ...eth,
    assetId: 'nep141:base.omft.near',
    rheaChainId: '8453',
    tokenListChainId: 8453,
    blockchain: 'base'
  }
  expect(getCrossChainSendWalletAssetId(bnb)).toBe('eip155:56/slip44:714')
  expect(
    getCrossChainSendAssetGroup({ chainId: 'eip155:56', namespace: 'slip44', reference: '714' })
  ).toBe(MARKET_ASSETS.bnb)
  expect(isCrossChainSendDestination(bnb, baseEth, enabledChains)).toBe(false)
  expect(getCrossChainSendDestinationAssetId('eip155:8453', MARKET_ASSETS.bnb)).toBeNull()

  const contract = '0x1234567890123456789012345678901234567890'
  const custom = {
    ...eth,
    assetId: 'nep141:shared-token.near',
    isNative: false,
    contractAddress: contract,
    rheaAddress: contract,
    symbol: 'CUSTOM'
  }
  const destination = {
    ...custom,
    rheaChainId: '8453',
    tokenListChainId: 8453,
    blockchain: 'base',
    contractAddress: '0x9876543210987654321098765432109876543210',
    rheaAddress: '0x9876543210987654321098765432109876543210'
  }
  expect(getCrossChainSendWalletAssetId(custom)).toBe(`eip155:1/erc20:${contract}`)
  expect(isCrossChainSendDestination(custom, destination, enabledChains)).toBe(true)
  expect(
    resolveCrossChainSendDestinationByWalletAssetId(
      custom,
      'eip155:8453/erc20:0x9876543210987654321098765432109876543210',
      [destination],
      enabledChains
    )
  ).toBe(destination)
  expect(
    isCrossChainSendDestination(
      custom,
      { ...destination, assetId: 'nep141:another-token.near' },
      enabledChains
    )
  ).toBe(false)
  expect(
    isCrossChainSendDestination(
      custom,
      { ...destination, assetId: 'rhea:shared-token' },
      enabledChains
    )
  ).toBe(false)
})
