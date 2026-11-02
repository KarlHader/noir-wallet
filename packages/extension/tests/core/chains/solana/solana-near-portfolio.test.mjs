import { test } from 'node:test'
import { expect } from '@playwright/test'

import { NEAR_NETWORKS } from '../../../../src/config/networks.ts'
import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'
import {
  createAddressGatedChainRegistry,
  createAssetRegistry,
  createInitialProductChainRegistry,
  filterAssetDefinitionsForChains,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { NearRpcError } from '../../../../src/infrastructure/chains/near/near-rpc-types.ts'
import { readNearPortfolioSource } from '../../../../src/infrastructure/chains/near/near-portfolio-source.ts'
import { SolanaRpcError } from '../../../../src/infrastructure/chains/solana/solana-rpc-types.ts'
import { readSolanaPortfolioSource } from '../../../../src/infrastructure/chains/solana/solana-portfolio-source.ts'
import {
  SingleChainPortfolioCoordinator,
  UnifiedPortfolioCoordinator
} from '../../../../src/infrastructure/portfolio/index.ts'

const generationId = 'storage-v2:generation:solana-near-portfolio'
const keyDomainId = 'wallet:solana-near-portfolio'
const accountId = 'account:solana-near-portfolio:0'
const solanaChainId = SOLANA_NETWORKS.devnet.chainId
const nearChainId = NEAR_NETWORKS.testnet.chainId
const solanaAddress = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const nearAddress = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412'
const blockHash = '11111111111111111111111111111111'

const chains = createAddressGatedChainRegistry(createInitialProductChainRegistry('testnet'), [
  'chain.solana',
  'chain.near'
])
const assets = createAssetRegistry(
  chains,
  filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains)
)
const solanaUsdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const assetsWithSolanaUsdc = createAssetRegistry(chains, [
  ...filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains),
  {
    chainId: solanaChainId,
    namespace: 'token',
    reference: solanaUsdcMint,
    kind: 'token',
    metadata: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    source: 'protocol',
    verification: 'trusted'
  }
])
const nearUsdtContract = 'usdt.tether-token.near'
const assetsWithNearUsdt = createAssetRegistry(chains, [
  ...filterAssetDefinitionsForChains(getBundledInitialProductAssetDefinitions('testnet'), chains),
  {
    chainId: nearChainId,
    namespace: 'nep141',
    reference: nearUsdtContract,
    kind: 'token',
    metadata: { name: 'Tether USD', symbol: 'USDT', decimals: 6 },
    source: 'protocol',
    verification: 'trusted'
  }
])

const solanaChainAccount = Object.freeze({
  id: 'chain-account:solana-near-portfolio:solana',
  scope: { keyDomainId, accountId, chainId: solanaChainId },
  derivation: { scheme: 'slip10', path: "m/44'/501'/0'/0'" },
  identity: { kind: 'account-identifier', value: solanaAddress },
  createdAt: 1_000
})
const nearChainAccount = Object.freeze({
  id: 'chain-account:solana-near-portfolio:near',
  scope: { keyDomainId, accountId, chainId: nearChainId },
  derivation: { scheme: 'slip10', path: "m/44'/397'/0'" },
  identity: { kind: 'account-identifier', value: nearAddress },
  createdAt: 1_000
})

function solanaRpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getBalanceSnapshot: async () => ({ contextSlot: 10, amountRaw: '1234567890' }),
    getTokenAccountsByMints: async () => {
      throw new Error('Native-only Portfolio must not enumerate SPL token accounts')
    },
    ...overrides
  }
}

function nearRpc(overrides = {}) {
  return {
    assertExpectedChain: async () => {},
    getAccount: async requestedAccountId => ({
      accountId: requestedAccountId,
      amountRaw: '100',
      lockedRaw: '20',
      storageUsage: 30,
      codeHash: blockHash,
      blockHash,
      blockHeight: 40
    }),
    getFinalBlock: async () => ({
      hash: blockHash,
      height: 41,
      timestampNanosec: '1',
      gasPriceRaw: '1'
    }),
    getFungibleTokenBalance: async () => {
      throw new Error('Native-only Portfolio must not query NEP-141 balances')
    },
    ...overrides
  }
}

function pointer() {
  return {
    schemaVersion: 2,
    generationId,
    sourceFingerprint: 'a'.repeat(64),
    committedAt: 1_000
  }
}

function snapshot() {
  return {
    manifest: {
      schemaVersion: 2,
      generationId,
      status: 'verified',
      sourceFingerprint: 'a'.repeat(64),
      mainKeyDomainId: keyDomainId,
      activeAccount: { keyDomainId, accountId }
    },
    keyDomains: [
      {
        id: keyDomainId,
        credentialRef: 'credential-set:solana-near-portfolio',
        source: { kind: 'software', mnemonicWordCount: 24 },
        displayName: 'Wallet 1',
        createdAt: 1_000
      }
    ],
    accounts: [
      {
        id: accountId,
        keyDomainId,
        accountIndex: 0,
        displayName: 'Account 1',
        createdAt: 1_000
      }
    ],
    chainAccounts: [solanaChainAccount, nearChainAccount],
    addresses: [
      {
        id: 'address:solana-near-portfolio:solana',
        chainAccountId: solanaChainAccount.id,
        value: solanaAddress,
        scheme: 'solana',
        purpose: 'identity',
        derivation: solanaChainAccount.derivation,
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      },
      {
        id: 'address:solana-near-portfolio:near',
        chainAccountId: nearChainAccount.id,
        value: nearAddress,
        scheme: 'near',
        purpose: 'identity',
        derivation: nearChainAccount.derivation,
        rotatable: false,
        preferredForReceive: true,
        privacy: 'transparent',
        walletCompatibility: 'broad'
      }
    ]
  }
}

test.describe('Solana and NEAR address-only Portfolio', () => {
  test('projects only trusted native balances with exact raw amount semantics', async () => {
    await expect(
      readSolanaPortfolioSource({
        chainAccount: solanaChainAccount,
        assets,
        rpc: solanaRpc(),
        now: () => 2_000
      })
    ).resolves.toEqual({
      chainAccount: solanaChainAccount,
      status: 'ready',
      balances: [
        {
          assetId: `${solanaChainId}/slip44:501`,
          totalRaw: '1234567890',
          spendableRaw: '1234567890',
          availableRaw: '1234567890',
          pendingRaw: '0',
          updatedAt: 2_000
        }
      ]
    })

    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets,
        rpc: nearRpc(),
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        {
          assetId: `${nearChainId}/slip44:397`,
          totalRaw: '120',
          spendableRaw: '100',
          availableRaw: '100',
          pendingRaw: '0',
          updatedAt: 2_000
        }
      ]
    })
  })

  test('treats an unfunded implicit NEAR account as zero and maps RPC failures without fabricating balances', async () => {
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets,
        rpc: nearRpc({ getAccount: async () => null }),
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [{ totalRaw: '0', spendableRaw: '0', availableRaw: '0' }]
    })

    await expect(
      readSolanaPortfolioSource({
        chainAccount: solanaChainAccount,
        assets,
        rpc: solanaRpc({
          assertExpectedChain: async () => {
            throw new SolanaRpcError('chain-mismatch', 'wrong chain')
          }
        })
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'invalid-response', balances: [] })

    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets,
        rpc: nearRpc({
          getAccount: async () => {
            throw new NearRpcError('rate-limited', 'limited')
          }
        })
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'rate-limited', balances: [] })
  })

  test('keeps an enabled SPL Token visible with a zero balance until a token account exists', async () => {
    const getTokenAccountsByMints = async () => ({ contextSlot: 10, accounts: [] })
    await expect(
      readSolanaPortfolioSource({
        chainAccount: solanaChainAccount,
        assets: assetsWithSolanaUsdc,
        rpc: solanaRpc({ getTokenAccountsByMints }),
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        { assetId: `${solanaChainId}/slip44:501`, totalRaw: '1234567890' },
        {
          assetId: `${solanaChainId}/token:${solanaUsdcMint}`,
          totalRaw: '0',
          spendableRaw: '0',
          availableRaw: '0'
        }
      ]
    })
  })

  test('uses the FastNear inventory for registered NEP-141 balances without per-token RPC reads', async () => {
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithNearUsdt,
        rpc: nearRpc(),
        tokenInventory: {
          getFungibleTokenBalances: async () => [
            {
              contractId: nearUsdtContract,
              amountRaw: '2500000',
              lastUpdateBlockHeight: 39
            }
          ]
        },
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      status: 'ready',
      balances: [
        { assetId: `${nearChainId}/slip44:397`, totalRaw: '120' },
        {
          assetId: `${nearChainId}/nep141:${nearUsdtContract}`,
          totalRaw: '2500000',
          spendableRaw: '2500000',
          availableRaw: '2500000'
        }
      ]
    })
  })

  test('falls back to one NEP-141 RPC read when FastNear has no usable balance', async () => {
    let rpcReads = 0
    await expect(
      readNearPortfolioSource({
        chainAccount: nearChainAccount,
        assets: assetsWithNearUsdt,
        rpc: nearRpc({
          getFungibleTokenBalance: async (contractId, requestedAccountId) => {
            rpcReads += 1
            return {
              contractId,
              accountId: requestedAccountId,
              amountRaw: '7000000',
              blockHash,
              blockHeight: 40
            }
          }
        }),
        tokenInventory: {
          getFungibleTokenBalances: async () => [
            {
              contractId: nearUsdtContract,
              amountRaw: null,
              lastUpdateBlockHeight: null
            }
          ]
        },
        now: () => 2_000
      })
    ).resolves.toMatchObject({
      balances: [
        { assetId: `${nearChainId}/slip44:397` },
        { assetId: `${nearChainId}/nep141:${nearUsdtContract}`, totalRaw: '7000000' }
      ]
    })
    expect(rpcReads).toBe(1)
  })

  test('persists generation-bound cache and composes both Beta chains through the unified model', async () => {
    const records = new Map()
    const cacheRepository = {
      get: async (requestedGenerationId, chainAccountId) =>
        records.get(JSON.stringify([requestedGenerationId, chainAccountId])) ?? null,
      put: async record => {
        records.set(JSON.stringify([record.generationId, record.source.chainAccount.id]), record)
      }
    }
    const storageRepository = {
      getActivePointer: async () => pointer(),
      getSnapshot: async () => snapshot()
    }
    const solanaPortfolio = new SingleChainPortfolioCoordinator({
      storageRepository,
      cacheRepository,
      chains,
      assets,
      chainId: solanaChainId,
      family: 'solana',
      now: () => 2_000,
      readSource: input => readSolanaPortfolioSource({ ...input, rpc: solanaRpc() })
    })
    const nearPortfolio = new SingleChainPortfolioCoordinator({
      storageRepository,
      cacheRepository,
      chains,
      assets,
      chainId: nearChainId,
      family: 'near',
      now: () => 2_000,
      readSource: input => readNearPortfolioSource({ ...input, rpc: nearRpc() })
    })

    await expect(solanaPortfolio.readCachedActiveSource()).resolves.toMatchObject({
      generationId,
      source: { status: 'loading', balances: [] }
    })
    await expect(solanaPortfolio.refreshActiveSource()).resolves.toMatchObject({
      generationId,
      source: { status: 'ready', balances: [{ totalRaw: '1234567890' }] }
    })

    const model = await new UnifiedPortfolioCoordinator({
      storageRepository,
      chains,
      assets,
      solanaPortfolio,
      nearPortfolio,
      readZcashState: () => ({ balance: null, status: 'loading', updatedAt: 0 })
    }).refreshActive()

    expect(model).toMatchObject({
      status: 'ready',
      chains: [
        { chain: { family: 'solana' }, status: 'ready' },
        { chain: { family: 'near' }, status: 'ready' }
      ],
      assets: [
        { metadata: { symbol: 'SOL' }, balance: { totalRaw: '1234567890' } },
        { metadata: { symbol: 'NEAR' }, balance: { totalRaw: '120' } }
      ]
    })
  })
})
