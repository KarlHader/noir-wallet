import { test } from 'node:test'
import { expect } from '@playwright/test'
import { ConfidentialFundingApi } from '../../../src/background/confidential-funding-api.ts'
import { ConfidentialFundingApiError } from '../../../src/background/confidential-funding-api.ts'
import { ConfidentialFundingCoordinator } from '../../../src/background/confidential-funding-coordinator.ts'
import { NearConfidentialDepositAdapter } from '../../../src/background/confidential-funding-adapters.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../src/core/chains/registry/index.ts'
import { getEvmNetworkConfigs } from '../../../src/config/networks.ts'
import { InMemoryTransactionRepository } from '../../../src/infrastructure/persistence/repositories/in-memory-transaction-repository.ts'

const apiConfig = {
  oneClickApiUrl: 'https://example.test/1click',
  oneClickDirectApiUrl: 'https://direct.example.test/v0',
  rheaSwapApiUrl: 'https://example.test'
}
const checksummedRecipient = '0x52908400098527886E0F7030069857D2E4169EE7'
const lowercaseRecipient = checksummedRecipient.toLowerCase()
const nearAccount = 'a'.repeat(64)
const scope = { keyDomainId: 'wallet:one', accountId: 'account:one' }

function quoteBody(request) {
  return {
    correlationId: 'near-quote',
    quoteRequest: request,
    quote: {
      amountIn: request.amount,
      amountOut: request.amount,
      minAmountOut: request.amount,
      depositAddress: nearAccount,
      deadline: request.deadline
    }
  }
}

test('NEAR Shield quotes lowercase a confidential EVM recipient and omit order chain id', async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  const statusUrls = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.includes('/api/swap/confidential-app-fee')) {
      return new Response(
        JSON.stringify({
          appId: 'test-app',
          confidentialAppFeeBps: 0,
          confidentialPlatformFeeBps: 0
        }),
        { status: 200 }
      )
    }
    if (href.includes('/api/swap/order-status')) {
      statusUrls.push(href)
      return new Response(JSON.stringify({ status: 'PENDING_DEPOSIT' }), { status: 200 })
    }
    const request = JSON.parse(init.body)
    bodies.push(request)
    return new Response(JSON.stringify(quoteBody(request)), { status: 200 })
  }
  try {
    const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'test-token')
    await api.quote({
      referral: 'noir_receive',
      originAsset: 'nep141:wrap.near',
      destinationAsset: 'nep141:wrap.near',
      amountRaw: '1000',
      signerId: lowercaseRecipient,
      refundTo: checksummedRecipient,
      recipient: checksummedRecipient,
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'CONFIDENTIAL_INTENTS',
      slippageBps: 50,
      dry: false
    })
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body.recipient).toBe(lowercaseRecipient)
      expect(body.refundTo).toBe(lowercaseRecipient)
      expect(body.recipient).not.toBe(checksummedRecipient)
      expect(body.originAsset).toBe('nep141:wrap.near')
      expect(body.destinationAsset).toBe('nep141:wrap.near')
      expect(body.depositType).toBe('ORIGIN_CHAIN')
      expect(body.refundType).toBe('ORIGIN_CHAIN')
      expect(body.recipientType).toBe('CONFIDENTIAL_INTENTS')
      expect(body.depositMode).toBe('SIMPLE')
      expect(body.confidentiality).toBe('basic')
      expect(body.memo).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain(checksummedRecipient)
    }

    const evmStart = bodies.length
    await api.quote({
      referral: 'noir_receive',
      originAsset: 'nep141:eth.omft.near',
      destinationAsset: 'nep141:eth.omft.near',
      amountRaw: '1000',
      signerId: checksummedRecipient,
      refundTo: checksummedRecipient,
      recipient: checksummedRecipient,
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'CONFIDENTIAL_INTENTS',
      slippageBps: 50,
      dry: false
    })
    expect(bodies[evmStart].recipient).toBe(checksummedRecipient)
    expect(bodies[evmStart].depositMode).toBeUndefined()

    const withdrawStart = bodies.length
    await api.quote({
      referral: 'noir_send',
      originAsset: 'nep141:wrap.near',
      destinationAsset: 'nep141:wrap.near',
      amountRaw: '1000',
      signerId: lowercaseRecipient,
      recipient: nearAccount,
      depositType: 'CONFIDENTIAL_INTENTS',
      refundType: 'CONFIDENTIAL_INTENTS',
      recipientType: 'DESTINATION_CHAIN',
      slippageBps: 50,
      dry: false
    })
    const withdraw = bodies[withdrawStart]
    expect(withdraw.refundTo).toBe(nearAccount)
    expect(withdraw.recipient).toBe(nearAccount)
    expect(withdraw.memo).toBeUndefined()
    expect(withdraw.depositMode).toBe('SIMPLE')

    for (const chainId of ['1', '900001', 'near', 'near:mainnet']) {
      await api.getStatus(nearAccount, chainId)
    }
    expect(statusUrls).toHaveLength(4)
    for (const href of statusUrls) {
      const query = new URL(href).searchParams
      expect(query.get('router')).toBe('nearintents')
      expect(query.get('orderId')).toBe(nearAccount)
      expect(query.has('chainId')).toBe(false)
      expect(href).not.toContain('chainId')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a NEAR Shield quote with a memo is rejected before use', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body)
    return new Response(
      JSON.stringify({
        ...quoteBody(request),
        quote: { ...quoteBody(request).quote, ...(request.dry ? {} : { depositMemo: 'memo' }) }
      }),
      { status: 200 }
    )
  }
  try {
    const api = new ConfidentialFundingApi(apiConfig, 'https://near.example.test', 'test-token')
    await expect(
      api.quote({
        referral: 'noir_receive',
        originAsset: 'nep141:wrap.near',
        destinationAsset: 'nep141:wrap.near',
        amountRaw: '1000',
        signerId: lowercaseRecipient,
        refundTo: nearAccount,
        recipient: lowercaseRecipient,
        depositType: 'ORIGIN_CHAIN',
        refundType: 'ORIGIN_CHAIN',
        recipientType: 'CONFIDENTIAL_INTENTS',
        slippageBps: 50,
        dry: false
      })
    ).rejects.toThrow('NEAR Shield quote must not include a memo')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('NEAR Shield deposit preparation requires a 64-hex deposit address', async () => {
  const prepared = []
  const account = {
    accountIndex: 0,
    mainAccountId: nearAccount,
    publicKey: 'ed25519:11111111111111111111111111111111',
    peaAccountId: 'b'.repeat(64)
  }
  const adapter = new NearConfidentialDepositAdapter(
    { resolve: async () => account },
    {
      prepare: async () => ({
        commandId: 'command-one',
        payloadFingerprint: 'c'.repeat(64),
        expiresAt: 10_000
      }),
      confirm: async () => {
        throw new Error('confirm was not expected')
      },
      cancel: async () => {}
    },
    {},
    async input => {
      prepared.push(input)
      return {
        kind: 'intents-deposit',
        recipientId: input.depositAddress,
        signerId: input.signerId,
        memo: input.memo
      }
    }
  )
  const identity = { address: lowercaseRecipient }
  const base = {
    identity,
    chainId: 'near:mainnet',
    assetId: 'near:mainnet/slip44:397',
    amountRaw: '1',
    sourceDomain: 'public'
  }
  for (const recipient of ['deposit.near', 'A'.repeat(64), `0x${'ab'.repeat(20)}`, 'a'.repeat(63)]) {
    await expect(adapter.prepareDeposit({ ...base, recipient })).rejects.toThrow(
      'NEAR Shield deposit address is invalid'
    )
  }
  expect(prepared).toEqual([])
  await adapter.prepareDeposit({ ...base, recipient: nearAccount })
  expect(prepared).toHaveLength(1)
  expect(prepared[0].depositAddress).toBe(nearAccount)
  expect(prepared[0].signerId).toBe(nearAccount)
  expect(prepared[0].chainId).toBe('near:mainnet')
  expect(Object.hasOwn(prepared[0], 'memo')).toBe(false)
  await expect(
    adapter.prepareDeposit({ ...base, chainId: 'near:testnet', recipient: nearAccount })
  ).rejects.toThrow('NEAR mainnet')
  expect(prepared).toHaveLength(1)
})

test('a failed NEAR Shield quote does not prepare a transfer', async () => {
  const chains = createInitialProductChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('mainnet'))
  const state = { prepared: 0, broadcasts: 0, quotes: [] }
  const now = 1_000_000
  const serviceError = new ConfidentialFundingApiError('recipient is not valid', 400, false)
  const coordinator = new ConfidentialFundingCoordinator({
    network: 'mainnet',
    api: {
      async getBalances() {
        return []
      },
      async quote(input) {
        state.quotes.push(input)
        throw serviceError
      }
    },
    store: {
      async listPlans() {
        return []
      },
      async getSession() {
        return {
          accessToken: 'session-token',
          refreshToken: 'refresh-token',
          expiresAt: now + 1_000_000,
          refreshExpiresAt: now + 2_000_000
        }
      },
      async putBalances() {}
    },
    signer: {
      async resolveIdentity() {
        return {
          address: checksummedRecipient,
          peaAddress: '0x2222222222222222222222222222222222222222',
          addressIndex: 0,
          context: { chainAccount: { scope: { ...scope, chainId: 'eip155:1' } } }
        }
      }
    },
    repository: new InMemoryTransactionRepository(),
    assets,
    evmNetworks: [getEvmNetworkConfigs('mainnet')[0]],
    assetMappings: Object.freeze([
      { assetId: 'near:mainnet/slip44:397', protocolAssetId: 'nep141:wrap.near' }
    ]),
    now: () => now,
    nearDeposit: {
      async resolveAccount() {
        return {
          accountIndex: 0,
          mainAccountId: nearAccount,
          publicKey: 'ed25519:11111111111111111111111111111111',
          peaAccountId: null
        }
      },
      adapter: {
        kind: 'near',
        async prepareDeposit() {
          state.prepared += 1
          throw new Error('public NEAR transfer')
        },
        async confirmDeposit() {
          throw new Error('public NEAR transfer')
        },
        async cancelDeposit() {}
      },
      async broadcastSignedTransaction() {
        state.broadcasts += 1
        throw new Error('public NEAR transfer')
      },
      async getTransactionStatus() {
        return { status: 'unknown' }
      }
    }
  })
  await expect(
    coordinator.prepare({
      network: 'mainnet',
      ...scope,
      operation: 'deposit',
      sourceDomain: 'public',
      destinationDomain: 'shield',
      source: {
        chainId: 'near:mainnet',
        chainName: 'near',
        assetId: 'near:mainnet/slip44:397',
        protocolAssetId: 'nep141:wrap.near',
        amountRaw: '1000'
      },
      destination: {
        chainId: 'near:mainnet',
        chainName: 'near',
        assetId: 'near:mainnet/slip44:397',
        protocolAssetId: 'nep141:wrap.near'
      },
      slippageBps: 50
    })
  ).rejects.toThrow('recipient is not valid')
  expect(state.prepared).toBe(0)
  expect(state.broadcasts).toBe(0)
  expect(state.quotes).toHaveLength(1)
  expect(state.quotes[0].recipient).toBe(lowercaseRecipient)
  expect(state.quotes[0].recipient).not.toBe(checksummedRecipient)
  expect(state.quotes[0].refundTo).toBe(nearAccount)
  expect(state.quotes[0].originAsset).toBe('nep141:wrap.near')
  expect(state.quotes[0].destinationAsset).toBe('nep141:wrap.near')
  expect(JSON.stringify(state.quotes[0])).not.toContain(`"recipient":"${checksummedRecipient}"`)
})
