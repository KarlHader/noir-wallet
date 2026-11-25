import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAssetId } from '../../../src/core/chains/registry/index.ts'
import { getPrivateCrossChainTransferAssetGroup } from '../../../src/core/chains/cross-chain-asset-group.ts'
import { selectShieldSameTokenAsset } from '../../../src/core/services/confidential-funding/shield-dapp-projection.ts'

const arbitrumUsdc = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const bnbUsdc = 'eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
const ethereumUsdc = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

function identityFor(assetId) {
  return getPrivateCrossChainTransferAssetGroup(parseAssetId(assetId))
}

test('USDC on Arbitrum quotes to BNB Chain USDC', () => {
  assert.equal(identityFor(arbitrumUsdc), identityFor(bnbUsdc))
  assert.equal(identityFor(arbitrumUsdc), identityFor(ethereumUsdc))
  assert.equal(
    selectShieldSameTokenAsset({
      sourceAssetId: arbitrumUsdc,
      sourceSymbol: 'USDC',
      destinationChainId: 'eip155:56',
      tokens: [
        { chainId: 'eip155:42161', assetId: arbitrumUsdc, symbol: 'USDC', decimals: 6 },
        { chainId: 'eip155:56', assetId: bnbUsdc, symbol: 'USDC', decimals: 18 },
        { chainId: 'eip155:1', assetId: ethereumUsdc, symbol: 'USDC', decimals: 6 }
      ],
      identityFor
    })?.assetId,
    bnbUsdc
  )
})
