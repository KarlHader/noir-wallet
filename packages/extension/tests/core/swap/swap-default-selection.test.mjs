import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  buildInitialSwapCatalogPlan,
  isSwapAssetOnEnabledChain,
  pickProvisionalSwapSource
} from '../../../src/popup/services/swap-catalog-loading.ts'
import {
  getSavedSwapDestinationAssetId,
  resolveSwapTokenSelection,
  shouldWaitForSwapDestination
} from '../../../src/popup/services/swap-token-selection.ts'
import { buildWalletSwapSourceBalances } from '../../../src/popup/services/swap-page-model.ts'

const zcashChain = {
  id: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  family: 'zcash',
  network: { kind: 'mainnet' }
}
const ethereumChain = { id: 'eip155:1', family: 'evm', network: { kind: 'mainnet' } }
const nearChain = { id: 'near:mainnet', family: 'near', network: { kind: 'mainnet' } }

const zec = {
  assetId: 'nep141:zec.omft.near',
  blockchain: 'zec',
  symbol: 'ZEC',
  rheaChainId: 'zcash',
  tokenListChainId: 900010,
  rheaAddress: 'zec',
  icon: null
}
const eth = { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH' }
const usdc = { assetId: 'nep141:eth-usdc.omft.near', blockchain: 'eth', symbol: 'USDC' }
const wnear = { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR' }

it('selects an enabled destination after the ZEC source loads without persisting an interim pair', () => {
  const enabledChains = [zcashChain, ethereumChain]
  const savedSelection = { tokenInId: zec.assetId, tokenOutId: zec.assetId }
  assert.equal(getSavedSwapDestinationAssetId(savedSelection), undefined)
  assert.deepEqual(
    buildInitialSwapCatalogPlan({ savedSourceAssetId: savedSelection.tokenInId, enabledChains }),
    { sourceChainIds: [900010], destinationChainIds: [1] }
  )
  const input = {
    tokens: [zec],
    sourceTokens: [zec],
    crossChainDestinationTokens: [],
    walletSourceTokens: [zec],
    savedSelection,
    enabledChains
  }
  assert.deepEqual(resolveSwapTokenSelection(input), { tokenIn: zec, tokenOut: null })
  assert.equal(pickProvisionalSwapSource([zec]), zec)
  assert.equal(
    shouldWaitForSwapDestination({ loading: true, resolvedDestinationAssetId: null }),
    true
  )
  assert.deepEqual(
    resolveSwapTokenSelection({ ...input, tokens: [zec, eth], crossChainDestinationTokens: [eth] }),
    { tokenIn: zec, tokenOut: eth }
  )
})

it('shows the native source as soon as its catalog arrives, before wallet balances or the destination', () => {
  const source = pickProvisionalSwapSource([
    { ...usdc, isNative: false },
    { ...eth, isNative: true }
  ])
  assert.equal(source?.assetId, eth.assetId)
})

it('does not default to an unopened NEAR network, even when its token is cached', () => {
  const input = {
    tokens: [zec, wnear],
    sourceTokens: [zec],
    crossChainDestinationTokens: [wnear],
    walletSourceTokens: [zec],
    enabledChains: [zcashChain]
  }
  assert.deepEqual(buildInitialSwapCatalogPlan({ enabledChains: [zcashChain] }), {
    sourceChainIds: [900010],
    destinationChainIds: []
  })
  assert.deepEqual(resolveSwapTokenSelection(input), { tokenIn: zec, tokenOut: null })
  assert.deepEqual(buildInitialSwapCatalogPlan({ enabledChains: [zcashChain, nearChain] }), {
    sourceChainIds: [900010],
    destinationChainIds: [900001]
  })
  assert.deepEqual(
    resolveSwapTokenSelection({ ...input, enabledChains: [zcashChain, nearChain] }),
    {
      tokenIn: zec,
      tokenOut: wnear
    }
  )
})

it('uses a distinct same-chain token for a single EVM-enabled account', () => {
  assert.deepEqual(buildInitialSwapCatalogPlan({ enabledChains: [ethereumChain] }), {
    sourceChainIds: [1],
    destinationChainIds: []
  })
  assert.deepEqual(
    resolveSwapTokenSelection({
      tokens: [eth, usdc, zec],
      sourceTokens: [eth, usdc],
      walletSourceTokens: [eth, usdc],
      enabledChains: [ethereumChain]
    }),
    { tokenIn: eth, tokenOut: usdc }
  )
})

it('keeps a newly selected source while the page still has an older wallet source list', () => {
  const input = {
    tokens: [zec, eth, usdc],
    sourceTokens: [zec, eth, usdc],
    crossChainDestinationTokens: [zec, eth],
    walletSourceTokens: [zec],
    savedSelection: { tokenInId: zec.assetId, tokenOutId: eth.assetId },
    selectedSourceAssetId: usdc.assetId,
    enabledChains: [zcashChain, ethereumChain]
  }
  assert.equal(resolveSwapTokenSelection(input)?.tokenIn.assetId, usdc.assetId)
  assert.equal(
    buildWalletSwapSourceBalances({
      tokens: [usdc],
      portfolio: null,
      receiveTargets: null,
      zcashAvailable: '0',
      evmExecutionMode: 'main'
    }).has(usdc.assetId),
    false
  )
  assert.equal(
    resolveSwapTokenSelection({ ...input, enabledChains: [zcashChain] })?.tokenIn.assetId,
    zec.assetId
  )
})

it('keeps a reversed source while wallet-owned assets are still loading', () => {
  const selection = resolveSwapTokenSelection({
    tokens: [zec, eth],
    sourceTokens: [zec, eth],
    crossChainDestinationTokens: [zec, eth],
    walletSourceTokens: [zec],
    selectedSourceAssetId: eth.assetId,
    enabledChains: [zcashChain, ethereumChain]
  })
  assert.deepEqual(selection, { tokenIn: eth, tokenOut: zec })
})

it('drops a source history from a disabled chain but preserves an external destination chosen manually', () => {
  const savedSelection = { tokenInId: zec.assetId, tokenOutId: wnear.assetId }
  assert.equal(isSwapAssetOnEnabledChain(zec.assetId, [ethereumChain]), false)
  assert.deepEqual(
    buildInitialSwapCatalogPlan({
      savedSourceAssetId: savedSelection.tokenInId,
      savedDestinationAssetId: savedSelection.tokenOutId,
      enabledChains: [ethereumChain]
    }),
    { sourceChainIds: [1], destinationChainIds: [] }
  )
  assert.deepEqual(
    resolveSwapTokenSelection({
      tokens: [zec, eth, usdc, wnear],
      sourceTokens: [eth, usdc],
      crossChainDestinationTokens: [wnear],
      walletSourceTokens: [eth, usdc],
      savedSelection,
      enabledChains: [ethereumChain]
    }),
    { tokenIn: eth, tokenOut: usdc }
  )
  assert.deepEqual(
    buildInitialSwapCatalogPlan({
      savedSourceAssetId: zec.assetId,
      savedDestinationAssetId: wnear.assetId,
      enabledChains: [zcashChain]
    }),
    { sourceChainIds: [900010], destinationChainIds: [900001] }
  )
  assert.deepEqual(
    resolveSwapTokenSelection({
      tokens: [zec, wnear],
      sourceTokens: [zec],
      crossChainDestinationTokens: [wnear],
      walletSourceTokens: [zec],
      savedSelection,
      enabledChains: [zcashChain]
    }),
    { tokenIn: zec, tokenOut: wnear }
  )
})

it('treats source and destination ZEC entries with different icons as the same asset', () => {
  const destinationZec = { ...zec, icon: 'https://example.com/zec.png' }
  assert.equal(zec.assetId, destinationZec.assetId)
  assert.equal(
    getSavedSwapDestinationAssetId({ tokenInId: zec.assetId, tokenOutId: destinationZec.assetId }),
    undefined
  )
  assert.deepEqual(
    resolveSwapTokenSelection({
      tokens: [zec, destinationZec],
      sourceTokens: [zec],
      crossChainDestinationTokens: [destinationZec],
      walletSourceTokens: [zec],
      savedSelection: { tokenInId: zec.assetId, tokenOutId: destinationZec.assetId },
      enabledChains: [zcashChain]
    }),
    { tokenIn: zec, tokenOut: null }
  )
})
