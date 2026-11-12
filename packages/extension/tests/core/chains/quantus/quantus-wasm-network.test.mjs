import { test } from 'node:test'
import { expect } from '@playwright/test'

import { QUANTUS_NETWORKS } from '../../../../src/config/networks.ts'
import {
  expectedQuantusWasmNetwork,
  QUANTUS_WASM_CHAIN_IDS,
  requiresQuantusGenesisBinding,
  toQuantusWasmChainId
} from '../../../../src/core/chains/quantus/wasm-network.ts'

test.describe('Quantus WASM network mapping', () => {
  test('keeps mainnet on its own identifier', () => {
    expect(toQuantusWasmChainId(QUANTUS_NETWORKS.mainnet.chainId)).toBe('quantus:mainnet')
    expect(expectedQuantusWasmNetwork(QUANTUS_NETWORKS.mainnet.chainId)).toBe('mainnet')
  })

  test('maps the CAIP-2 Planck testnet onto the WASM dev reference', () => {
    // The packaged WASM rejects `quantus:planck`; the host translates at the
    // engine boundary and keeps the host chain ID in every response.
    expect(toQuantusWasmChainId(QUANTUS_NETWORKS.testnet.chainId)).toBe('quantus:dev')
    expect(expectedQuantusWasmNetwork(QUANTUS_NETWORKS.testnet.chainId)).toBe('dev')
    expect(requiresQuantusGenesisBinding(toQuantusWasmChainId(QUANTUS_NETWORKS.testnet.chainId))).toBe(
      true
    )
    expect(
      requiresQuantusGenesisBinding(toQuantusWasmChainId(QUANTUS_NETWORKS.mainnet.chainId))
    ).toBe(false)
  })

  test('rejects identifiers the product does not declare', () => {
    for (const chainId of ['quantus:dev', 'quantus:heisenberg', 'quantus:other', 'polkadot:1']) {
      expect(() => toQuantusWasmChainId(chainId)).toThrow(/Unsupported Quantus chain ID/)
    }
  })

  test('only declares identifiers the packaged engine exports capabilities for', () => {
    expect([...QUANTUS_WASM_CHAIN_IDS]).toEqual([
      'quantus:mainnet',
      'quantus:dev',
      'quantus:heisenberg'
    ])
  })
})
