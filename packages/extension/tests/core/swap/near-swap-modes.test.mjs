import { test } from 'node:test'
import { expect } from '@playwright/test'

import { RheaSwapNearCoordinator } from '../../../src/background/rhea-swap-near.ts'
import { normalizeNearConfidentialQuote } from '../../../src/background/confidential-near-quote.ts'
import { createInitialProductChainRegistry } from '../../../src/core/chains/registry/index.ts'
import {
  assertNearPrivateQuoteRoute,
  NEAR_INCOGNITO_UNFUNDED_ERROR
} from '../../../src/core/services/rhea-swap/rhea-swap-near-private-route.ts'
import { prependRheaSwapNearWrap } from '../../../src/core/services/rhea-swap/rhea-swap-near-wrap.ts'
import { resolveIntentsWalletAsset } from '../../../src/core/services/intents-wallet-assets.ts'
import { nearPeaRequestJson } from '../../../src/infrastructure/keyring/multichain/raw-wallet-engine.ts'
import {
  nearPrivateSwapExecutionAvailable,
  readNearSwapBalanceRaw,
  selectNearQuoteAssetExecution
} from '../../../src/popup/services/near-quote-asset-execution.ts'
import { selectWalletOwnedQuoteAssetExecution } from '../../../src/popup/services/quote-deposit-transfer-client.ts'
import { isPrivateSwapDestinationSupported } from '../../../src/popup/services/swap-page-model.ts'
import { listShieldFundingAssets } from '../../../src/popup/services/shield-transfer.ts'

const MAIN = 'alice.near'
const PEA = 'ab'.repeat(32)
const OTHER_PEA = 'cd'.repeat(32)
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n

function balance(values) {
  return {
    asset: { id: 'near:mainnet/slip44:397', chainId: 'near:mainnet', kind: 'native' },
    metadata: { decimals: 24, symbol: 'NEAR' },
    balance: values
  }
}

test('reads Main, Incognito, and Shield NEAR balances from separate buckets', () => {
  const split = {
    availableRaw: '100',
    mainRaw: '40',
    privateRaw: '60',
    privateOnchainRaw: '25',
    confidentialRaw: '15'
  }
  expect(readNearSwapBalanceRaw(split, 'main')).toBe('40')
  expect(readNearSwapBalanceRaw(split, 'incognito')).toBe('25')
  expect(readNearSwapBalanceRaw(split, 'shield')).toBe('15')
  expect(readNearSwapBalanceRaw({ availableRaw: '42' }, 'incognito')).toBe('42')
  expect(
    readNearSwapBalanceRaw(
      { availableRaw: '100', mainRaw: '40', privateRaw: '60', confidentialRaw: '15' },
      'incognito'
    )
  ).toBeUndefined()
})

test('selects the PEA balance and refund address for Incognito NEAR execution', () => {
  const source = {
    family: 'near',
    refundAddress: MAIN,
    asset: balance({
      availableRaw: '100',
      mainRaw: '40',
      privateRaw: '60',
      privateOnchainRaw: '25',
      confidentialRaw: '15'
    }),
    networkFeeAsset: balance({
      availableRaw: '100',
      mainRaw: '40',
      privateRaw: '60',
      privateOnchainRaw: '7',
      confidentialRaw: '15'
    })
  }
  expect(selectNearQuoteAssetExecution(source, 'main')?.asset.balance.availableRaw).toBe('40')
  expect(selectNearQuoteAssetExecution(source, 'main')?.refundAddress).toBe(MAIN)
  const incognito = selectNearQuoteAssetExecution(source, 'private', PEA)
  expect(incognito?.asset.balance.availableRaw).toBe('25')
  expect(incognito?.networkFeeAsset.balance.availableRaw).toBe('7')
  expect(incognito?.refundAddress).toBe(PEA)
  expect(selectNearQuoteAssetExecution(source, 'private', MAIN)).toBeNull()
  expect(selectNearQuoteAssetExecution(source, 'private', PEA.toUpperCase())).toBeNull()
  expect(
    selectNearQuoteAssetExecution(
      {
        ...source,
        asset: balance({ availableRaw: '100', mainRaw: '40', privateRaw: '60' })
      },
      'private',
      PEA
    )
  ).toBeNull()
})

test('keeps native NEAR and wNEAR on separate wallet assets', () => {
  const fields = { blockchain: 'near', decimals: 24, symbol: 'NEAR', price: 1, priceUpdatedAt: '' }
  expect(
    resolveIntentsWalletAsset(
      { ...fields, assetId: 'nep141:wrap.near', contractAddress: null },
      'mainnet'
    )?.assetId
  ).toBe('near:mainnet/slip44:397')
  expect(
    resolveIntentsWalletAsset(
      { ...fields, assetId: 'nep141:wrap.near', symbol: 'wNEAR', contractAddress: 'wrap.near' },
      'mainnet'
    )?.assetId
  ).toBe('near:mainnet/nep141:wrap.near')
})

test('uses the wallet-owned NEAR leaf for Main and Incognito execution', () => {
  const chain = {
    chain: {
      id: 'near:mainnet',
      family: 'near',
      capabilities: { transaction: { status: 'available' } }
    }
  }
  const asset = balance({
    availableRaw: '100',
    mainRaw: '40',
    privateRaw: '60',
    privateOnchainRaw: '25',
    confidentialRaw: '15'
  })
  const portfolio = {
    scope: { keyDomainId: 'wallet:test', accountId: 'account:test' },
    chains: [chain],
    assets: [asset]
  }
  const targets = {
    keyDomainId: 'wallet:test',
    accountId: 'account:test',
    targets: [{ chain: { id: 'near:mainnet' }, kind: 'near', address: MAIN }]
  }
  const token = {
    assetId: 'nep141:wrap.near',
    blockchain: 'near',
    contractAddress: null,
    decimals: 24,
    symbol: 'NEAR',
    price: 1,
    priceUpdatedAt: ''
  }
  const owned = {
    family: 'near',
    asset,
    networkFeeAsset: asset,
    chain,
    sourceAssetId: token.assetId,
    refundAddress: MAIN
  }
  expect(selectWalletOwnedQuoteAssetExecution(owned, 'main')?.asset.balance.availableRaw).toBe('40')
  expect(selectWalletOwnedQuoteAssetExecution(owned, 'private', PEA)?.refundAddress).toBe(PEA)
  expect(portfolio.assets[0].asset.id).toBe('near:mainnet/slip44:397')
  expect(targets.targets[0].address).toBe(MAIN)
  expect(token.assetId).toBe('nep141:wrap.near')
})

test('allows Incognito NEAR only for a distinct PEA, including imported keys at index 0', () => {
  const pea = { privateExecutionAddress: PEA, mainAddresses: [MAIN] }
  expect(
    nearPrivateSwapExecutionAvailable({
      enabledFlags: ['chain.near'],
      walletSource: { kind: 'software' },
      ...pea
    })
  ).toBe(true)
  expect(
    nearPrivateSwapExecutionAvailable({
      enabledFlags: ['chain.near'],
      walletSource: { kind: 'private-key', chainFamily: 'near', accountIndex: 0 },
      ...pea
    })
  ).toBe(true)
  expect(
    nearPrivateSwapExecutionAvailable({
      enabledFlags: ['chain.near'],
      walletSource: { kind: 'private-key', chainFamily: 'near', accountIndex: 1 },
      ...pea
    })
  ).toBe(false)
  expect(
    nearPrivateSwapExecutionAvailable({
      enabledFlags: [],
      walletSource: { kind: 'software' },
      ...pea
    })
  ).toBe(false)
  expect(
    nearPrivateSwapExecutionAvailable({
      enabledFlags: ['chain.near'],
      walletSource: { kind: 'hardware' },
      ...pea
    })
  ).toBe(false)
})

test('accepts an Incognito NEAR destination at the persisted PEA', () => {
  const chain = {
    chain: {
      id: 'near:mainnet',
      family: 'near',
      capabilities: { transaction: { status: 'available' } }
    }
  }
  const portfolio = {
    scope: { keyDomainId: 'wallet:test', accountId: 'account:test' },
    chains: [chain],
    assets: [balance({ availableRaw: '1', mainRaw: '1', privateOnchainRaw: '1' })]
  }
  const targets = {
    keyDomainId: 'wallet:test',
    accountId: 'account:test',
    targets: [{ chain: { id: 'near:mainnet' }, kind: 'near', address: MAIN }]
  }
  const token = {
    assetId: 'nep141:wrap.near',
    blockchain: 'near',
    rheaChainId: 'near',
    contractAddress: null,
    decimals: 24,
    symbol: 'NEAR',
    price: 1,
    priceUpdatedAt: ''
  }
  const addresses = new Map([['near:mainnet', PEA]])
  expect(isPrivateSwapDestinationSupported(token, portfolio, targets, addresses, 'private')).toBe(
    true
  )
  expect(
    isPrivateSwapDestinationSupported(
      token,
      portfolio,
      targets,
      new Map([['near:mainnet', MAIN]]),
      'private'
    )
  ).toBe(false)
})

function quoteAccount(pea = PEA) {
  return {
    walletId: 'wallet:test',
    accountId: 'account:test',
    networks: [
      {
        chainId: 'near:mainnet',
        privateExecutionAddress: pea,
        addresses: [{ value: MAIN }]
      }
    ]
  }
}

function quoteRequest(sender, recipient = PEA) {
  return {
    fromChain: 'near',
    toChain: 'near',
    tokenIn: { address: 'near' },
    tokenOut: { address: 'wrap.near' },
    sender,
    recipient,
    confidentiality: undefined
  }
}

test('rejects a public NEAR sender instead of falling through to the public route', () => {
  let publicRouteCalled = false
  const rejectPublic = () => {
    publicRouteCalled = true
    throw new Error('public route')
  }
  expect(() =>
    assertNearPrivateQuoteRoute(
      quoteRequest(MAIN, MAIN),
      quoteAccount(),
      'private-swap',
      { walletId: 'wallet:test', accountId: 'account:test' },
      rejectPublic
    )
  ).toThrow(NEAR_INCOGNITO_UNFUNDED_ERROR)
  expect(publicRouteCalled).toBe(false)
  expect(() =>
    assertNearPrivateQuoteRoute(
      quoteRequest(OTHER_PEA),
      quoteAccount(),
      'private-swap',
      undefined,
      rejectPublic
    )
  ).toThrow(NEAR_INCOGNITO_UNFUNDED_ERROR)
  expect(publicRouteCalled).toBe(false)
  expect(() =>
    assertNearPrivateQuoteRoute(
      quoteRequest(PEA),
      quoteAccount(),
      'private-swap',
      { walletId: 'wallet:test', accountId: 'account:test' },
      rejectPublic
    )
  ).not.toThrow()
  expect(
    createInitialProductChainRegistry('mainnet')
      .list()
      .some(chain => chain.family === 'near')
  ).toBe(true)
})

test('builds the PEA request without an app or chain id', () => {
  expect(nearPeaRequestJson(4)).toBe('{"version":2,"family":"near","parent":{"accountIndex":4}}')
  expect(nearPeaRequestJson(4)).not.toContain('appId')
  expect(nearPeaRequestJson(4)).not.toContain('chainId')
})

function swapBinding(sender, native = false) {
  return {
    schemaVersion: 1,
    provider: 'rhea-cross-chain-dex',
    kind: 'swap',
    quoteHandle: 'rhea-quote:near-one',
    executionId: 'execution-near-one',
    router: 'near-intents',
    sourceTarget: 'router.near',
    sender,
    originAmountRaw: '1000',
    expiresAt: 5_000,
    isCrossChain: true,
    origin: {
      chainId: 'near:mainnet',
      assetId: native ? 'near:mainnet/slip44:397' : 'near:mainnet/nep141:usdc.near',
      protocolChainId: 'near',
      protocolAssetId: native ? 'native' : 'nep141:usdc.near'
    },
    destination: {
      chainId: 'zcash:mainnet',
      assetId: 'zcash:mainnet/slip44:133',
      protocolChainId: 'zcash',
      protocolAssetId: 'nep141:zec.omft.near',
      recipient: 'u1destination',
      expectedAmountRaw: '900',
      minimumAmountRaw: '850'
    }
  }
}

function swapPlan(sender, native = false) {
  return {
    quoteHandle: 'rhea-quote:near-one',
    executionId: 'execution-near-one',
    chain: 'near',
    tokenIn: native ? 'near' : 'usdc.near',
    amountIn: '1000',
    transactions: [
      {
        signerId: sender,
        receiverId: 'router.near',
        actions: [
          {
            type: 'FunctionCall',
            params: {
              methodName: 'swap',
              args: { amount: '1000' },
              gas: '1000000000000',
              deposit: '1'
            }
          }
        ]
      }
    ]
  }
}

function createCoordinator(options) {
  const prepared = []
  const calls = []
  const coordinator = new RheaSwapNearCoordinator({
    service: {
      async readNearTransactionBatchPlan() {
        return options.plan
      },
      async recordTransactionSubmission() {
        throw new Error('unexpected submission')
      },
      async reportSubmission() {
        throw new Error('unexpected report')
      },
      async discard() {},
      async readPreparedBuild() {
        return { request: {}, fromChain: 'near', toChain: 'near', raw: {}, execution: {} }
      }
    },
    signer: {
      async prepare(_keyDomainId, payload) {
        prepared.push(payload)
        calls.push(payload.kind)
        return {
          commandId: 'command-near-0',
          chainId: 'near:mainnet',
          operation: 'transaction',
          summary: {
            schema: 'near.transaction.v1',
            chainId: 'near:mainnet',
            operation: 'transaction',
            review: { level: 'standard', issues: [] },
            fields: {
              signerId: payload.transaction.signerId,
              receiverId: payload.transaction.receiverId
            }
          },
          payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
          execution: { kind: 'internal' },
          expiresAt: 5_000
        }
      },
      async confirm() {
        throw new Error('unexpected confirm')
      },
      async cancel() {}
    },
    rpc: {
      async assertExpectedChain() {},
      async getAccessKey(accountId) {
        calls.push(`access:${accountId}`)
        return options.accessKey === null
          ? null
          : {
              accountId,
              publicKey: 'ed25519:key',
              nonce: '4',
              permission: { kind: 'full-access' },
              blockHash: '1'.repeat(32),
              blockHeight: 1
            }
      },
      async getFungibleTokenBalance(_contractId, accountId) {
        return { contractId: 'wrap.near', accountId, amountRaw: options.wrappedBalance ?? '0' }
      },
      async isFungibleTokenAccountRegistered() {
        return options.registered ?? true
      },
      async broadcastSignedTransaction() {
        throw new Error('unexpected broadcast')
      },
      async getTransactionStatus() {
        return { status: 'unknown' }
      }
    },
    pending: {
      async get() {
        return null
      },
      async list() {
        return []
      },
      async put() {},
      async delete() {}
    },
    repository: {
      async create() {
        throw new Error('unexpected create')
      },
      async get() {
        return null
      },
      async applySegmentEvent() {
        throw new Error('unexpected event')
      }
    },
    loadContext: async () => ({
      accountIndex: options.accountIndex ?? 0,
      publicKey: `ed25519:${'1'.repeat(32)}`,
      keyDomainSource: options.keyDomainSource ?? { kind: 'software' },
      chainAccount: {
        id: 'chain-account-near',
        scope: {
          keyDomainId: 'wallet:near',
          accountId: 'account:near',
          chainId: 'near:mainnet'
        },
        identity: { kind: 'account-identifier', value: MAIN }
      }
    }),
    deriveNearPea: options.deriveNearPea,
    scheduleMonitoring: async () => {},
    now: () => 1_000,
    createId: () => 'stable-near-mode'
  })
  return { coordinator, prepared, calls }
}

test('signs an Incognito NEAR swap with the PEA and refuses a public fallback', async () => {
  const incognito = createCoordinator({
    plan: swapPlan(PEA),
    accountIndex: 4,
    deriveNearPea: async (_keyDomainId, accountIndex) => {
      expect(accountIndex).toBe(4)
      return { address: PEA }
    }
  })
  await incognito.coordinator.prepare(swapBinding(PEA).quoteHandle, swapBinding(PEA))
  expect(incognito.prepared).toHaveLength(1)
  expect(Object.keys(incognito.prepared[0]).sort()).toEqual([
    'accountIndex',
    'chainId',
    'kind',
    'transaction'
  ])
  expect(incognito.prepared[0].kind).toBe('pea-near-transaction')
  expect(incognito.prepared[0].accountIndex).toBe(4)
  expect(incognito.prepared[0].transaction.signerId).toBe(PEA)
  expect(incognito.calls).toContain(`access:${PEA}`)
  expect(nearPeaRequestJson(4)).toBe('{"version":2,"family":"near","parent":{"accountIndex":4}}')

  const mismatched = createCoordinator({
    plan: swapPlan(PEA),
    deriveNearPea: async () => ({ address: OTHER_PEA })
  })
  await expect(
    mismatched.coordinator.prepare(swapBinding(PEA).quoteHandle, swapBinding(PEA))
  ).rejects.toThrow(NEAR_INCOGNITO_UNFUNDED_ERROR)
  expect(mismatched.prepared).toHaveLength(0)
  expect(mismatched.calls).not.toContain('near-transaction')

  const unregistered = createCoordinator({
    plan: swapPlan(PEA, true),
    registered: false,
    wrappedBalance: '0',
    deriveNearPea: async () => ({ address: PEA })
  })
  await expect(
    unregistered.coordinator.prepare(swapBinding(PEA, true).quoteHandle, swapBinding(PEA, true))
  ).rejects.toThrow(NEAR_INCOGNITO_UNFUNDED_ERROR)
  expect(unregistered.prepared).toHaveLength(0)
})

test('keeps the public NEAR wrap as a separate near_deposit batch', () => {
  const wrapped = prependRheaSwapNearWrap({
    transactions: [
      {
        receiverId: 'router.near',
        actions: [
          {
            type: 'functionCall',
            methodName: 'swap',
            args: {},
            gas: '1000000000000',
            deposit: '1'
          }
        ]
      }
    ],
    amountIn: '1000',
    wrappedBalanceRaw: '400',
    registered: false
  })
  expect(wrapped).toHaveLength(2)
  expect(wrapped[0]).toEqual({
    receiverId: 'wrap.near',
    actions: [
      {
        type: 'functionCall',
        methodName: 'near_deposit',
        args: {},
        gas: '50000000000000',
        deposit: (600n + STORAGE_DEPOSIT).toString()
      }
    ]
  })
  expect(wrapped[1].receiverId).toBe('router.near')
})

test('public NEAR execution still signs the Main account wrap with near-transaction', async () => {
  const harness = createCoordinator({
    plan: swapPlan(MAIN, true),
    registered: false,
    wrappedBalance: '400',
    keyDomainSource: { kind: 'software' }
  })
  await harness.coordinator.prepare(swapBinding(MAIN, true).quoteHandle, swapBinding(MAIN, true))
  expect(harness.prepared.map(payload => payload.kind)).toEqual([
    'near-transaction',
    'near-transaction'
  ])
  expect(harness.prepared[0].transaction).toMatchObject({
    signerId: MAIN,
    receiverId: 'wrap.near',
    actions: [
      {
        type: 'functionCall',
        methodName: 'near_deposit',
        gas: '50000000000000',
        depositYocto: (600n + STORAGE_DEPOSIT).toString()
      }
    ]
  })
})

test('lists Shield NEAR nep141 assets from confidential balances when the chain is enabled', () => {
  const nearChain = createInitialProductChainRegistry('mainnet').resolve('near:mainnet')
  const model = {
    chains: [{ chain: nearChain, status: 'ready', assets: [], errorCodes: [] }],
    assets: [],
    confidential: {
      status: 'ready',
      assets: [
        {
          tokenId: 'nep141:token.near',
          protocolAssetId: 'nep141:token.near',
          assetId: 'near:mainnet/nep141:token.near',
          chainId: 'near:mainnet',
          availableRaw: '42',
          decimals: 18
        },
        {
          tokenId: 'nep141:wrap.near',
          protocolAssetId: 'nep141:wrap.near',
          assetId: 'near:mainnet/slip44:397',
          chainId: 'near:mainnet',
          availableRaw: '9',
          decimals: 24
        }
      ]
    }
  }
  const tokens = [
    {
      assetId: 'nep141:wrap.near',
      blockchain: 'near',
      decimals: 24,
      symbol: 'NEAR',
      price: 1,
      priceUpdatedAt: ''
    },
    {
      assetId: 'nep141:token.near',
      blockchain: 'near',
      decimals: 18,
      symbol: 'TKN',
      price: 1,
      priceUpdatedAt: ''
    },
    {
      assetId: 'nep141:eth.omft.near',
      blockchain: 'near',
      decimals: 18,
      symbol: 'ETH',
      price: 1,
      priceUpdatedAt: ''
    }
  ]
  const previous = globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
  globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.near']
  try {
    const listed = listShieldFundingAssets(model, [], tokens, 'mainnet')
    expect(listed.map(item => item.managed.protocolAssetId).sort()).toEqual([
      'nep141:token.near',
      'nep141:wrap.near'
    ])
    expect(
      listed.find(item => item.managed.protocolAssetId === 'nep141:wrap.near')?.asset.asset.id
    ).toBe('near:mainnet/slip44:397')
    expect(
      listed.find(item => item.managed.protocolAssetId === 'nep141:token.near')?.asset.balance
        .confidentialRaw
    ).toBe('42')
  } finally {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = previous
  }
  expect(listShieldFundingAssets(model, [], tokens, 'mainnet')).toEqual([])
})

test('lowercases confidential EVM addresses on NEAR-source quotes and keeps deposits memo-free', () => {
  const checksummed = '0x52908400098527886E0F7030069857D2E4169EE7'
  const normalized = normalizeNearConfidentialQuote({
    originAsset: 'nep141:token.near',
    recipient: checksummed,
    refundTo: checksummed,
    recipientType: 'CONFIDENTIAL_INTENTS',
    refundType: 'CONFIDENTIAL_INTENTS'
  })
  expect(normalized.recipient).toBe(checksummed.toLowerCase())
  expect(normalized.refundTo).toBe(checksummed.toLowerCase())
  expect(
    normalizeNearConfidentialQuote({
      originAsset: 'nep141:eth.omft.near',
      recipient: checksummed,
      recipientType: 'CONFIDENTIAL_INTENTS',
      refundType: 'CONFIDENTIAL_INTENTS'
    }).recipient
  ).toBe(checksummed)
})
