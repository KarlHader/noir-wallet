import { test } from 'node:test'
import { expect } from '@playwright/test'

import { isAssetVisibleInAssetView } from '../../../src/popup/components/portfolio/portfolio-asset-visibility.ts'
import { applyTokenDisplayPolicy } from '../../../src/core/portfolio/portfolio-visibility.ts'

function chain(id, family, displayName) {
  return { id, family, displayName }
}

function asset({ kind = 'native', symbol, totalRaw = '0' }) {
  return {
    asset: { kind },
    metadata: { symbol },
    balance: { totalRaw }
  }
}

test.describe('Portfolio asset-mode visibility', () => {
  test('shows held assets and registered zero-balance Tokens', () => {
    expect(
      isAssetVisibleInAssetView(
        chain('near:mainnet', 'near', 'NEAR'),
        asset({ symbol: 'NEAR', totalRaw: '1' })
      )
    ).toBe(true)
    expect(
      isAssetVisibleInAssetView(chain('near:mainnet', 'near', 'NEAR'), asset({ symbol: 'NEAR' }))
    ).toBe(false)
    expect(
      isAssetVisibleInAssetView(
        chain('eip155:1', 'evm', 'Ethereum'),
        asset({ kind: 'token', symbol: 'USDC' })
      )
    ).toBe(true)
  })

  test('keeps zero-balance native ZEC, BTC and Ethereum ETH as empty-state actions', () => {
    expect(
      isAssetVisibleInAssetView(
        chain('bip122:zcash-mainnet', 'zcash', 'Zcash'),
        asset({ symbol: 'ZEC' })
      )
    ).toBe(true)
    expect(
      isAssetVisibleInAssetView(
        chain('bip122:zcash-testnet', 'zcash', 'Zcash Testnet'),
        asset({ symbol: 'ZEC' })
      )
    ).toBe(true)
    expect(
      isAssetVisibleInAssetView(
        chain('bip122:mainnet', 'bitcoin', 'Bitcoin'),
        asset({ symbol: 'BTC' })
      )
    ).toBe(true)
    expect(
      isAssetVisibleInAssetView(chain('eip155:1', 'evm', 'Ethereum'), asset({ symbol: 'ETH' }))
    ).toBe(true)
    expect(
      isAssetVisibleInAssetView(chain('eip155:42161', 'evm', 'Arbitrum'), asset({ symbol: 'ETH' }))
    ).toBe(false)
    expect(
      isAssetVisibleInAssetView(
        chain('solana:mainnet', 'solana', 'Solana'),
        asset({ symbol: 'SOL' })
      )
    ).toBe(false)
  })

  test('shows a selected network native asset and registered empty tokens', () => {
    const arbitrum = chain('eip155:42161', 'evm', 'Arbitrum')
    const options = { includeZeroBalanceNativeAssets: true }
    expect(isAssetVisibleInAssetView(arbitrum, asset({ symbol: 'ETH' }), options)).toBe(true)
    expect(
      isAssetVisibleInAssetView(arbitrum, asset({ kind: 'token', symbol: 'USDC' }), options)
    ).toBe(true)
    expect(isAssetVisibleInAssetView(arbitrum, asset({ kind: 'token', symbol: 'ZEC' }))).toBe(true)
    expect(
      isAssetVisibleInAssetView(
        chain('eip155:11155111', 'evm', 'Ethereum Sepolia'),
        asset({ symbol: 'ETH' })
      )
    ).toBe(true)
  })
})

test('admits automatically held Tokens only by exact identity while preserving explicit choices', () => {
  const native = 'eip155:1/slip44:60'
  const id = number => `eip155:1/erc20:0x${String(number).repeat(40)}`
  const rows = [
    [native, 'native', '0'],
    [id(1), 'token', '0'], // Pinned by configuration.
    [id(2), 'token', '1'], // Curated and held.
    [id(3), 'token', '0'], // Curated, but empty and not pinned.
    [id(4), 'token', '1000000'], // Unlisted token impersonating USDC.
    [id(5), 'token', '0'], // User explicitly enabled an unlisted token.
    [id(6), 'token', '1'] // User hid a curated token.
  ].map(([assetId, kind, totalRaw]) => ({
    asset: { id: assetId, kind },
    metadata: { symbol: 'USDC' },
    balance: { totalRaw }
  }))
  const model = {
    chains: [{ assets: rows }],
    assets: rows,
    confidential: {
      status: 'ready',
      assets: [
        { assetId: native, availableRaw: '1' },
        { assetId: id(2), availableRaw: '1' },
        { assetId: id(4), availableRaw: '1000000', priceUsd: '999' },
        { availableRaw: '1000000', symbol: 'USDC' }
      ]
    }
  }
  const filtered = applyTokenDisplayPolicy(model, {
    allowedAssetIds: new Set([id(1), id(2), id(3), id(6)]),
    defaultAssetIds: new Set([id(1), id(6)]),
    visibleAssetIds: new Set([id(5), id(6)]),
    hiddenAssetIds: new Set([id(6)])
  })
  expect(filtered.assets.map(row => row.asset.id)).toEqual([native, id(1), id(2), id(5)])
  expect(filtered.chains[0].assets).toEqual(filtered.assets)
  expect(filtered.confidential.assets.map(row => row.assetId)).toEqual([native, id(2)])
  expect(model.assets).toHaveLength(7)
})
