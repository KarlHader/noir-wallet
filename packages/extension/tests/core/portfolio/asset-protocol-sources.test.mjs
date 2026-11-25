import { createProtocolMappings as createMappings } from '../../helpers/asset-market-fixtures.mjs'
import { test } from 'node:test'
import { expect } from '@playwright/test'

test('maps every supported mainnet quote asset to its exact 1Click chain identity', () => {
  const { assets, mappings } = createMappings('mainnet')
  expect(mappings).toHaveLength(11)
  expect(new Set(mappings.map(mapping => mapping.assetId)).size).toBe(11)
  expect(new Set(mappings.map(mapping => mapping.protocolAssetId)).size).toBe(11)

  const byAssetId = new Map(mappings.map(mapping => [mapping.assetId, mapping.protocolAssetId]))
  expect(byAssetId.get('eip155:1/slip44:60')).toBe('nep141:eth.omft.near')
  expect(byAssetId.get('eip155:42161/slip44:60')).toBe('nep141:arb.omft.near')
  expect(byAssetId.get('eip155:8453/slip44:60')).toBe('nep141:base.omft.near')
  expect(byAssetId.get('eip155:56/slip44:714')).toBe('nep141:bnb.omdep.near')
  expect(byAssetId.get('eip155:137/slip44:966')).toBe('nep141:pol.omdep.near')
  expect(byAssetId.get('eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831')).toBe(
    'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'
  )
  expect(mappings.map(mapping => assets.resolve(mapping.assetId).asset.chainId)).toContain(
    'eip155:137'
  )
})

test('does not expose mainnet protocol assets from a testnet wallet build', () => {
  expect(createMappings('testnet').mappings).toEqual([])
})
