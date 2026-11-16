import { test } from 'node:test'
import { expect } from '@playwright/test'
import {
  getCrossChainSendAssetGroup,
  getCrossChainSendDestinationAssetId,
  getCrossChainSendRouteCost,
  getCrossChainSendWalletAssetId,
  isCrossChainSendDestination,
  isCrossChainSendRecipientValid,
  resolveCrossChainSendDestinationByWalletAssetId,
  resolveCrossChainSendRouteAssetDisplay,
  resolveCrossChainSendRouteDraft
} from '../../../src/popup/services/cross-chain-send-assets.ts'
import { getSwapDestinationTokens } from '../../../src/popup/services/swap-token-selection.ts'

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
  const route = {
    network: 'mainnet',
    walletId: 'wallet-1',
    accountId: 'account-1',
    currentWalletId: 'wallet-1',
    currentAccountId: 'account-1',
    routeWalletId: 'wallet-1',
    routeAccountId: 'account-1',
    navigationState: null,
    sourceAssetId: 'eip155:42161/slip44:60',
    destinationAssetId: 'eip155:1/slip44:60',
    recipient: '0x1111111111111111111111111111111111111111',
    amount: '0.000001'
  }
  expect(resolveCrossChainSendRouteDraft(route)).toMatchObject({
    recipient: route.recipient,
    amount: route.amount,
    sourceSymbol: 'ETH',
    destinationName: 'Ethereum'
  })
  expect(resolveCrossChainSendRouteDraft({ ...route, accountId: 'account-2' })).toBeNull()
  const navigationState = {
    crossChainSendRouteAccount: {
      walletId: route.routeWalletId,
      accountId: route.routeAccountId,
      sourceAssetId: route.sourceAssetId,
      destinationAssetId: route.destinationAssetId
    }
  }
  expect(
    resolveCrossChainSendRouteDraft({
      ...route,
      walletId: null,
      accountId: null,
      currentWalletId: null,
      currentAccountId: null,
      navigationState
    })
  ).toMatchObject({ recipient: route.recipient, amount: route.amount })
  expect(
    resolveCrossChainSendRouteDraft({
      ...route,
      walletId: null,
      accountId: null,
      currentWalletId: 'wallet-2',
      currentAccountId: 'account-2',
      navigationState
    })
  ).toBeNull()
  expect(
    resolveCrossChainSendRouteAssetDisplay({ ...route, accountId: 'account-2' })
  ).toMatchObject({
    sourceSymbol: 'ETH',
    destinationName: 'Ethereum'
  })
  expect(
    resolveCrossChainSendRouteDraft({ ...route, destinationAssetId: 'eip155:1/slip44:0' })
  ).toMatchObject({ destinationName: 'Ethereum' })
  expect(
    resolveCrossChainSendRouteDraft({ ...route, destinationAssetId: route.sourceAssetId })
  ).toMatchObject({ destinationName: 'Arbitrum' })
})

test('cross-chain Send uses verified asset identities and excludes the source network', () => {
  const baseEth = { ...eth, rheaChainId: '8453', tokenListChainId: 8453, blockchain: 'base' }
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
  ).toBe('ETH')
  expect(
    getCrossChainSendAssetGroup({
      chainId: 'eip155:8453',
      namespace: 'erc20',
      reference: '0x0000000000000000000000000000000000000001'
    })
  ).toBe(null)
  expect(getCrossChainSendDestinationAssetId('eip155:8453', 'ETH')).toBe('eip155:8453/slip44:60')

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
      getCrossChainSendDestinationAssetId('eip155:137', 'USDC'),
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
  ).toBe('USDC')
  expect(isCrossChainSendRecipientValid(solanaUsdc, solanaUsdc.rheaAddress)).toBe(true)
  expect(isCrossChainSendRecipientValid(solanaUsdc, 'invalid')).toBe(false)
  expect(isCrossChainSendRecipientValid(usdc, `0x${'12'.repeat(20)}`)).toBe(true)
  expect(isCrossChainSendRecipientValid(usdc, '0x1234')).toBe(false)
  expect(
    getCrossChainSendDestinationAssetId('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'USDC')
  ).toBe(
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  )
  expect(getCrossChainSendWalletAssetId(solanaUsdc)).toBe(
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  )
})
