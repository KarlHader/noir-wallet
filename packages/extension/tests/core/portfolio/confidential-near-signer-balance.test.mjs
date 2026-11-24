import { test } from 'node:test'
import { expect } from '@playwright/test'

import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import {
  ChromeConfidentialFundingStore,
  serializeConfidentialFundingPlan
} from '../../../src/background/confidential-funding-store.ts'

const SCOPE = { keyDomainId: 'wallet:one', accountId: 'account:one' }
const EVM = '0x1111111111111111111111111111111111111111'
const NEAR = 'ab'.repeat(32)
const SHARED = 'nep141:shared.near'
const ONLY_NEAR = 'nep141:only.near'
const FREE = 'nep141:free.near'
const ASSET_ID = 'eip155:1/slip44:60'
const PROTOCOL_ASSET_ID = 'nep141:eth.omft.near'
const RECIPIENT = '0x3333333333333333333333333333333333333333'

function balance(tokenId, available) {
  return { tokenId, available, source: 'intents' }
}

function storageArea() {
  const values = new Map()
  return {
    get: async key =>
      key === null
        ? Object.fromEntries(values)
        : Array.isArray(key)
          ? Object.fromEntries(
              key
                .filter(item => values.has(item))
                .map(item => [item, structuredClone(values.get(item))])
            )
          : values.has(key)
            ? { [key]: structuredClone(values.get(key)) }
            : {},
    set: async entries => {
      for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value))
    },
    remove: async key => {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
    }
  }
}

function installWebLocksStub() {
  const previousLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  let lockTail = Promise.resolve()
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name, operation) => {
        const previous = lockTail
        let release
        lockTail = new Promise(resolve => {
          release = resolve
        })
        await previous
        try {
          return await operation()
        } finally {
          release()
        }
      }
    }
  })
  return () => {
    if (previousLocks === undefined) delete globalThis.navigator.locks
    else Object.defineProperty(globalThis.navigator, 'locks', previousLocks)
  }
}

function holding(model, protocolAssetId) {
  return model.confidential.assets.find(asset => asset.protocolAssetId === protocolAssetId)
}

test('lists a NEAR balance snapshot without copying the EVM record', async () => {
  const now = 10_000
  const local = storageArea()
  const session = storageArea()
  const previousChrome = globalThis.chrome
  globalThis.chrome = { storage: { local, session } }
  const restoreLocks = installWebLocksStub()
  try {
    const store = new ChromeConfidentialFundingStore(() => now)
    const evmBalances = [balance(SHARED, '10')]
    const nearBalances = [balance(SHARED, '4'), balance(ONLY_NEAR, '7')]
    await store.putBalances('mainnet', SCOPE.keyDomainId, SCOPE.accountId, evmBalances, now)
    await store.putBalances('mainnet', SCOPE.keyDomainId, SCOPE.accountId, nearBalances, now, NEAR)
    await expect(
      store.getBalanceSnapshot('mainnet', SCOPE.keyDomainId, SCOPE.accountId)
    ).resolves.toMatchObject({ balances: evmBalances })
    const listed = await store.listSignerBalanceSnapshots(
      'mainnet',
      SCOPE.keyDomainId,
      SCOPE.accountId
    )
    expect(listed.map(entry => entry.signerId)).toEqual([NEAR])
    expect(listed[0].snapshot.balances).toEqual(nearBalances)
  } finally {
    restoreLocks()
    if (previousChrome === undefined) delete globalThis.chrome
    else globalThis.chrome = previousChrome
  }
})

function projectionCoordinator(resolveIdentity) {
  const evmBalances = [balance(SHARED, '100'), balance('nep141:evm-only.near', '10')]
  const nearBalances = [balance(SHARED, '80'), balance(ONLY_NEAR, '40'), balance(FREE, '15')]
  const plans = [
    {
      planId: 'evm-shared',
      network: 'mainnet',
      ...SCOPE,
      phase: 'prepared',
      approvalExpiresAt: 5_000,
      requiresDeposit: false,
      operation: 'withdraw',
      signerId: EVM,
      source: { protocolAssetId: SHARED, amountRaw: '40' },
      splitSourceAmounts: [],
      withdraws: []
    },
    {
      planId: 'near-shared',
      network: 'mainnet',
      ...SCOPE,
      phase: 'needs-auth',
      resumePhase: 'signing-withdraws',
      approvalExpiresAt: 5_000,
      requiresDeposit: true,
      operation: 'cluster',
      signerId: NEAR,
      source: { protocolAssetId: SHARED, amountRaw: '30' },
      splitSourceAmounts: ['15', '15'],
      withdraws: [
        { status: 'PREPARED', depositAddress: '' },
        { status: 'PREPARED', depositAddress: '' }
      ]
    },
    {
      planId: 'near-stuck',
      network: 'mainnet',
      ...SCOPE,
      phase: 'needs-auth',
      approvalExpiresAt: 5_000,
      requiresDeposit: true,
      operation: 'cluster',
      signerId: NEAR,
      source: { protocolAssetId: ONLY_NEAR, amountRaw: '40' },
      splitSourceAmounts: ['40'],
      withdraws: [
        {
          status: 'SIGNED',
          depositAddress: 'pending.near',
          signedPayload: { standard: 'nep413' }
        }
      ]
    },
    {
      planId: 'evm-free',
      network: 'mainnet',
      ...SCOPE,
      phase: 'prepared',
      approvalExpiresAt: 5_000,
      requiresDeposit: false,
      operation: 'withdraw',
      signerId: EVM,
      source: { protocolAssetId: FREE, amountRaw: '15' },
      splitSourceAmounts: [],
      withdraws: []
    }
  ]
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    now: () => 1_000,
    store: {
      getBalanceSnapshot: async () => ({
        balances: evmBalances,
        fresh: true,
        known: true,
        updatedAt: 1_000
      }),
      listSignerBalanceSnapshots: async () => [
        {
          signerId: NEAR,
          snapshot: { balances: nearBalances, fresh: true, known: true, updatedAt: 1_000 }
        }
      ],
      listPlans: async () => plans
    },
    api: {},
    signer: { resolveIdentity },
    repository: {},
    assets: { get: () => undefined },
    evmNetworks: [{ chainId: 'eip155:1', rpcUrl: 'https://rpc.example.test' }],
    assetMappings: []
  })
  return coordinator.enrichPortfolio(
    { scope: SCOPE, status: 'ready', assets: [], chains: [] },
    false
  )
}

test('an EVM account projects only its EVM confidential snapshot', async () => {
  const chains = []
  const model = await projectionCoordinator(async chainId => {
    chains.push(chainId)
    if (chainId !== 'eip155:1') {
      throw new Error('Confidential funding requires an active software EVM Account')
    }
    return {
      kind: 'evm',
      address: EVM,
      peaAddress: EVM,
      addressIndex: 0,
      context: { chainAccount: { scope: { ...SCOPE, chainId } } }
    }
  })

  expect(chains).toEqual(['eip155:1'])
  expect(holding(model, SHARED)).toMatchObject({ availableRaw: '100', spendableRaw: '60' })
  expect(holding(model, 'nep141:evm-only.near')).toMatchObject({
    availableRaw: '10',
    spendableRaw: '10'
  })
  expect(holding(model, ONLY_NEAR)).toBeUndefined()
  expect(holding(model, FREE)).toBeUndefined()
})

test('a NEAR-only account projects only its NEAR snapshot and reserves that signer', async () => {
  const chains = []
  const model = await projectionCoordinator(async chainId => {
    chains.push(chainId)
    if (String(chainId).startsWith('eip155:')) {
      throw new Error('Confidential funding requires an active software EVM Account')
    }
    return {
      kind: 'near',
      address: NEAR,
      peaAddress: 'cd'.repeat(32),
      addressIndex: 0,
      context: { chainAccount: { scope: { ...SCOPE, chainId } } }
    }
  })

  expect(chains).toEqual(['eip155:1', 'near:mainnet'])
  expect(holding(model, SHARED)).toMatchObject({ availableRaw: '80', spendableRaw: '50' })
  expect(holding(model, ONLY_NEAR)).toMatchObject({ availableRaw: '40', spendableRaw: '0' })
  expect(holding(model, FREE)).toMatchObject({ availableRaw: '15', spendableRaw: '15' })
  expect(holding(model, 'nep141:evm-only.near')).toBeUndefined()
})

test('does not spend the NEAR signer when the EVM snapshot is short', async () => {
  const now = 1_000_000
  const plans = new Map()
  let evmAvailable = '10'
  let nearAvailable = '4'
  const quotedSigners = []
  const identityChains = []
  const identity = chainId =>
    chainId === 'near:mainnet'
      ? {
          kind: 'near',
          address: NEAR,
          peaAddress: 'cd'.repeat(32),
          addressIndex: 2,
          context: { chainAccount: { scope: { ...SCOPE, chainId } } }
        }
      : {
          kind: 'evm',
          address: EVM,
          peaAddress: EVM,
          addressIndex: 0,
          context: { chainAccount: { scope: { ...SCOPE, chainId } } }
        }
  const session = accessToken => ({
    accessToken,
    refreshToken: 'refresh',
    expiresAt: now + 1_000_000,
    refreshExpiresAt: now + 2_000_000
  })
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    now: () => now,
    store: {
      getPlan: async id => plans.get(id) ?? null,
      listPlans: async () => [...plans.values()],
      putPlan: async value => {
        plans.set(value.planId, serializeConfidentialFundingPlan(value))
      },
      deletePlan: async id => {
        plans.delete(id)
      },
      getSession: async (_network, _keyDomainId, _accountId, signerId) =>
        session(signerId === NEAR ? 'near-token' : 'evm-token'),
      putBalances: async () => {},
      getBalanceSnapshot: async () => ({ balances: [], fresh: true, known: true, updatedAt: now })
    },
    api: {
      getBalances: async accessToken => [
        balance(PROTOCOL_ASSET_ID, accessToken === 'near-token' ? nearAvailable : evmAvailable)
      ],
      quote: async input => {
        quotedSigners.push(input.signerId)
        const deadline = new Date(now + 60_000).toISOString()
        return {
          correlationId: 'quote-one',
          quoteRequest: {
            swapType: 'EXACT_INPUT',
            confidentiality: 'basic',
            originAsset: input.originAsset,
            destinationAsset: input.destinationAsset,
            amount: input.amountRaw,
            refundTo: input.refundTo ?? input.signerId,
            depositType: input.depositType,
            refundType: input.refundType,
            recipient: input.recipient,
            recipientType: input.recipientType,
            slippageTolerance: input.slippageBps,
            deadline,
            dry: input.dry,
            appFees: [{ recipient: 'platform.near', fee: 50 }]
          },
          quote: {
            amountIn: input.amountRaw,
            amountOut: input.amountRaw,
            minAmountOut: input.amountRaw,
            depositAddress: 'deposit.near',
            deadline
          }
        }
      }
    },
    signer: {
      resolveIdentity: async chainId => {
        identityChains.push(chainId)
        return identity(chainId)
      }
    },
    repository: {},
    assets: {
      get: id => ({
        asset: { id, chainId: 'eip155:1', kind: 'native', namespace: 'slip44' },
        metadata: { symbol: 'ETH', decimals: 18 }
      }),
      list: () => []
    },
    evmNetworks: [],
    assetMappings: [{ assetId: ASSET_ID, protocolAssetId: PROTOCOL_ASSET_ID }]
  })
  const request = amountRaw => ({
    network: 'mainnet',
    ...SCOPE,
    operation: 'withdraw',
    sourceDomain: 'shield',
    destinationDomain: 'public',
    source: {
      chainId: 'eip155:1',
      chainName: 'eth',
      assetId: ASSET_ID,
      protocolAssetId: PROTOCOL_ASSET_ID,
      amountRaw
    },
    destination: {
      chainId: 'eip155:1',
      chainName: 'eth',
      assetId: ASSET_ID,
      protocolAssetId: PROTOCOL_ASSET_ID
    },
    externalRecipient: RECIPIENT,
    slippageBps: 100
  })

  const covered = await coordinator.prepare(request('10'))
  const coveredPlan = await coordinator.getPlan(covered.planId)
  expect(coveredPlan.signerId).toBe(EVM)
  expect(coveredPlan.addressIndex).toBe(0)
  expect(coveredPlan.source.address).toBe(EVM)
  expect(quotedSigners.at(-1)).toBe(EVM)
  await coordinator.cancel(covered.planId)

  evmAvailable = '3'
  nearAvailable = '9'
  const chainsBeforeShortfall = identityChains.length
  await expect(coordinator.prepare(request('4'))).rejects.toThrow('insufficient')
  expect(quotedSigners).toEqual([EVM])
  expect(identityChains.slice(chainsBeforeShortfall)).not.toContain('near:mainnet')
})
