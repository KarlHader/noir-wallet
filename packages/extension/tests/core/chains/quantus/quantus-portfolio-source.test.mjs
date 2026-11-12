import { test } from 'node:test'
import { expect } from '@playwright/test'

import { QUANTUS_NETWORKS } from '../../../../src/config/networks.ts'
import { parseQuantusAddress } from '../../../../src/core/chains/quantus/identifiers.ts'
import {
  createAddressGatedChainRegistry,
  createAssetRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { QuantusRpcError } from '../../../../src/infrastructure/chains/quantus/quantus-rpc-types.ts'
import { readQuantusPortfolioSource } from '../../../../src/infrastructure/chains/quantus/quantus-portfolio-source.ts'

const chainId = QUANTUS_NETWORKS.testnet.chainId
const address = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'
const chainAccount = Object.freeze({
  id: 'chain-account:quantus-portfolio:quantus',
  scope: {
    keyDomainId: 'wallet:quantus-portfolio',
    accountId: 'account:quantus-portfolio:0',
    chainId
  },
  derivation: { scheme: 'ml-dsa-87', path: "m/44'/189189'/0'/0'/0'" },
  identity: { kind: 'account-identifier', value: address },
  createdAt: 1_000
})

const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.quantus'
])
const assets = createAssetRegistry(
  chains,
  filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains)
)

function rpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getAccountInfo: async () => ({ free: 5_000n, reserved: 2_000n, nonce: 7 }),
    ...overrides
  }
}

test.describe('Quantus Portfolio source', () => {
  test('reports free as spendable and free plus reserved as the total', async () => {
    parseQuantusAddress(chainAccount.identity.value)
    const source = await readQuantusPortfolioSource({
      chainAccount,
      assets,
      rpc: rpc(),
      now: () => 1_234
    })
    expect(source).toMatchObject({
      chainAccount,
      status: 'ready',
      balances: [
        {
          assetId: `${chainId}/slip44:189189`,
          totalRaw: '7000',
          spendableRaw: '5000',
          availableRaw: '7000',
          pendingRaw: '0',
          updatedAt: 1_234
        }
      ]
    })
  })

  test('maps an unavailable RPC to a retryable error without a verified zero balance', async () => {
    const source = await readQuantusPortfolioSource({
      chainAccount,
      assets,
      rpc: rpc({
        getAccountInfo: async () => {
          throw new QuantusRpcError('timeout', 'Quantus RPC request timed out')
        }
      })
    })
    expect(source).toMatchObject({
      status: 'error',
      errorCode: 'network-unavailable',
      balances: []
    })
  })

  test('propagates cancellation instead of caching an error state', async () => {
    await expect(
      readQuantusPortfolioSource({
        chainAccount,
        assets,
        rpc: rpc({
          assertExpectedChain: async () => {
            throw new QuantusRpcError('cancelled', 'Quantus RPC request was cancelled')
          }
        })
      })
    ).rejects.toThrow('cancelled')
  })

  test('rejects a ChainAccount the Worker cannot sign for', async () => {
    await expect(
      readQuantusPortfolioSource({
        chainAccount: {
          ...chainAccount,
          derivation: { scheme: 'sr25519', path: "m/44'/189189'/0'/0'/0'" }
        },
        assets,
        rpc: rpc()
      })
    ).rejects.toThrow('unsupported derivation scheme')
  })
})
