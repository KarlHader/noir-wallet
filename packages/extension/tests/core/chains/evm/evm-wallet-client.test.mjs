import { test } from 'node:test'
import { expect } from '@playwright/test'

import { createEvmWalletClient } from '../../../../src/popup/services/evm-wallet-client.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { buildPortfolioReadModel } from '../../../../src/core/portfolio/index.ts'
import { userEvmAssetToDefinition } from '../../../../src/core/chains/user-assets/index.ts'
import { SOLANA_NETWORKS } from '../../../../src/config/networks.ts'

const chainId = 'eip155:1'
const from = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const transactionId = 'transaction:evm:client'
const segmentId = 'segment:evm:client'
const fingerprint = 'a'.repeat(64)
const customContract = '0x3333333333333333333333333333333333333333'
const customAssetId = `${chainId}/erc20:${customContract}`

function customPortfolioEnvelope() {
  const userAsset = Object.freeze({
    assetId: customAssetId,
    chainId,
    contractAddress: customContract,
    metadata: { name: 'Example Token', symbol: 'USDC', decimals: 18 },
    addedAt: 10
  })
  const chains = createInitialProductChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions('mainnet'),
    userEvmAssetToDefinition(userAsset)
  ])
  const scope = { keyDomainId: 'key-domain:evm', accountId: 'account:evm' }
  const model = buildPortfolioReadModel(
    scope,
    [
      {
        chainAccount: {
          id: 'chain-account:evm:portfolio',
          scope: { ...scope, chainId },
          derivation: { scheme: 'bip44', path: "m/44'/60'/0'/0/0" },
          identity: { kind: 'account-identifier', value: from },
          createdAt: 1
        },
        status: 'ready',
        balances: [
          {
            assetId: customAssetId,
            totalRaw: '1000000000000000000',
            spendableRaw: '1000000000000000000',
            availableRaw: '1000000000000000000',
            pendingRaw: '0',
            updatedAt: 10
          }
        ]
      }
    ],
    chains,
    assets
  )
  return { result: { model, userAssets: [userAsset], detectedAssets: [], protocolAssets: [] } }
}

function solanaProtocolPortfolioEnvelope() {
  const chainId = SOLANA_NETWORKS.mainnet.chainId
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const assetId = `${chainId}/token:${mint}`
  const protocolAsset = Object.freeze({
    chainId,
    namespace: 'token',
    reference: mint,
    kind: 'token',
    metadata: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    source: 'protocol',
    verification: 'trusted'
  })
  const chains = createInitialProductChainRegistry('mainnet')
  const assets = createAssetRegistry(chains, [
    ...getBundledInitialProductAssetDefinitions('mainnet'),
    protocolAsset
  ])
  const scope = { keyDomainId: 'key-domain:solana', accountId: 'account:solana' }
  const model = buildPortfolioReadModel(
    scope,
    [
      {
        chainAccount: {
          id: 'chain-account:solana:portfolio',
          scope: { ...scope, chainId },
          derivation: { scheme: 'slip10', path: "m/44'/501'/0'/0'" },
          identity: {
            kind: 'account-identifier',
            value: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
          },
          createdAt: 1
        },
        status: 'ready',
        balances: [
          {
            assetId,
            totalRaw: '2500000',
            spendableRaw: '2500000',
            availableRaw: '2500000',
            pendingRaw: '0',
            updatedAt: 10
          }
        ]
      }
    ],
    chains,
    assets
  )
  return { result: { model, userAssets: [], detectedAssets: [], protocolAssets: [protocolAsset] } }
}

function graph(status = 'prepared', ids = { transactionId, segmentId }) {
  return {
    root: {
      id: ids.transactionId,
      scope: { keyDomainId: 'key-domain:evm', accountId: 'account:evm' },
      kind: 'transfer',
      status,
      segmentIds: [ids.segmentId],
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      intent: {
        schemaVersion: 1,
        direction: 'outgoing',
        primaryAmount: { assetId: `${chainId}/slip44:60`, amountRaw: '1' },
        feeLimit: { assetId: `${chainId}/slip44:60`, amountRaw: '63000' },
        sender: { chainId, address: from },
        recipient: { chainId, address: recipient }
      }
    },
    segments: [
      {
        id: ids.segmentId,
        transactionId: ids.transactionId,
        role: 'origin',
        target: { kind: 'onchain', chainId },
        status,
        ...(status === 'broadcast' ? { evidence: { transactionHash: `0x${'b'.repeat(64)}` } } : {}),
        requiredForFinality: true,
        dependsOn: [],
        createdAt: 1,
        updatedAt: 1,
        revision: 0
      }
    ]
  }
}

function summary() {
  return {
    schema: 'evm.transaction.v1',
    chainId,
    operation: 'transaction',
    review: { level: 'standard', issues: [] },
    fields: {
      transactionType: 'eip1559',
      from,
      to: recipient,
      nonce: '0',
      valueWei: '1',
      gasLimit: '21000',
      maximumFeeWei: '63000',
      gasPriceWei: null,
      maxFeePerGasWei: '3',
      maxPriorityFeePerGasWei: '1',
      accessList: [],
      calldata: {
        encoding: 'hex',
        value: '0x',
        byteLength: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      },
      methodSelector: null
    }
  }
}

function review() {
  return {
    graph: graph(),
    review: {
      chainId,
      operation: 'transaction',
      summary: summary(),
      payloadFingerprint: { algorithm: 'sha256', digestHex: fingerprint },
      expiresAt: 5_000
    }
  }
}

function cancellationReview(originalTransactionId = 'transaction:evm:original') {
  const value = review()
  value.graph.root.kind = 'cancel'
  value.graph.root.relation = { kind: 'replacement-of', transactionId: originalTransactionId }
  value.graph.root.intent.direction = 'self'
  delete value.graph.root.intent.primaryAmount
  value.graph.root.intent.recipient.address = from
  value.review.summary.fields.to = from
  value.review.summary.fields.valueWei = '0'
  return value
}

function activity(status = 'confirming') {
  const value = graph('broadcast')
  return {
    result: {
      scope: value.root.scope,
      items: [
        {
          id: value.root.id,
          source: 'wallet-v2',
          scope: value.root.scope,
          kind: value.root.kind,
          status,
          snapshot: value.root.intent,
          segments: value.segments.map(segment => ({
            id: segment.id,
            role: segment.role,
            target: segment.target,
            status,
            evidence: {
              transactionHash: `0x${'b'.repeat(64)}`,
              confirmations: 1,
              requiredConfirmations: 2
            }
          })),
          completeness: 'complete',
          createdAt: 1,
          updatedAt: 2
        }
      ],
      partialItemCount: 0
    }
  }
}

test.describe('Popup EVM wallet client', () => {
  test('binds an allowance read to its chain and selected owner and rejects malformed values', async () => {
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return { result: '2000000' }
    })

    await expect(
      client.getTokenAllowance(chainId, customContract, recipient, from, 'private')
    ).resolves.toBe('2000000')
    expect(messages).toEqual([
      {
        type: 'GET_EVM_TOKEN_ALLOWANCE',
        chainId,
        token: customContract,
        spender: recipient,
        expectedOwner: from,
        executionMode: 'private'
      }
    ])
    await expect(
      client.getTokenAllowance(chainId, 'invalid', recipient, from)
    ).rejects.toMatchObject({ code: 'invalid-request' })
    expect(messages).toHaveLength(1)

    const malformed = createEvmWalletClient(async () => ({ result: '0x1e8480' }))
    await expect(
      malformed.getTokenAllowance(chainId, customContract, recipient, from)
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('atomically validates a custom Token inventory with its Portfolio model', async () => {
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return customPortfolioEnvelope()
    })

    await expect(client.getPortfolio('refresh')).resolves.toMatchObject({
      status: 'ready',
      assets: [
        {
          asset: { id: customAssetId },
          metadata: { name: 'Example Token', symbol: 'USDC', decimals: 18 },
          balance: { availableRaw: '1000000000000000000' }
        }
      ]
    })
    await expect(client.getPortfolio('refresh', { forceDiscovery: true })).resolves.toMatchObject({
      status: 'ready'
    })
    await expect(client.getPortfolio('refresh', { chainIds: ['eip155:1'] })).resolves.toMatchObject(
      { status: 'ready' }
    )
    expect(messages).toEqual([
      { type: 'GET_PORTFOLIO', action: 'refresh' },
      { type: 'GET_PORTFOLIO', action: 'refresh', forceDiscovery: true },
      { type: 'GET_PORTFOLIO', action: 'refresh', chainIds: ['eip155:1'] }
    ])

    const substituted = customPortfolioEnvelope()
    substituted.result.userAssets = []
    const invalid = createEvmWalletClient(async () => substituted)
    await expect(invalid.getPortfolio('read')).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('atomically validates protocol Solana Tokens with the Portfolio model', async () => {
    const envelope = solanaProtocolPortfolioEnvelope()
    const client = createEvmWalletClient(async () => envelope)

    await expect(client.getPortfolio('refresh')).resolves.toMatchObject({
      status: 'ready',
      assets: [
        {
          metadata: { symbol: 'USDC', decimals: 6 },
          balance: { availableRaw: '2500000' }
        }
      ]
    })

    const substituted = solanaProtocolPortfolioEnvelope()
    substituted.result.protocolAssets = []
    const invalid = createEvmWalletClient(async () => substituted)
    await expect(invalid.getPortfolio('read')).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('sends only public transfer intent data and strictly decodes the review', async () => {
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return { result: review() }
    })

    await expect(
      client.prepareTransfer(
        {
          assetId: `${chainId}/slip44:60`,
          recipient,
          amountRaw: '1'
        },
        { feeTier: 'fast', executionMode: 'private' }
      )
    ).resolves.toMatchObject({
      graph: { root: { id: transactionId, status: 'prepared' } },
      review: { chainId, payloadFingerprint: { digestHex: fingerprint } }
    })
    expect(messages).toEqual([
      {
        type: 'PREPARE_EVM_TRANSFER',
        intent: { assetId: `${chainId}/slip44:60`, recipient, amountRaw: '1' },
        feeSelection: { kind: 'tier', tier: 'fast' },
        executionMode: 'private'
      }
    ])
    expect(JSON.stringify(messages)).not.toContain('commandId')
    expect(JSON.stringify(messages)).not.toContain('password')
  })

  for (const kind of ['contract-call', 'approve']) {
    test(`accepts an unbound ${kind} review for temporary fee estimation`, async () => {
      const value = review()
      value.graph.root.kind = kind
      value.graph.root.intent.direction = 'contract'
      const client = createEvmWalletClient(async () => ({ result: value }))
      await expect(
        client.prepareContractCall({
          chainId,
          contractAddress: recipient,
          valueRaw: '1',
          calldata: '0x12345678'
        })
      ).resolves.toMatchObject({ graph: { root: { kind } } })
    })
  }

  for (const field of ['sender', 'recipient', 'amount', 'fee']) {
    test(`rejects a contract review whose ${field} differs from its signing summary`, async () => {
      const value = review()
      value.graph.root.kind = 'contract-call'
      value.graph.root.intent.direction = 'contract'
      if (field === 'sender') value.graph.root.intent.sender.address = recipient
      if (field === 'recipient') value.graph.root.intent.recipient.address = from
      if (field === 'amount') value.graph.root.intent.primaryAmount.amountRaw = '2'
      if (field === 'fee') value.graph.root.intent.feeLimit.amountRaw = '63001'
      const client = createEvmWalletClient(async () => ({ result: value }))
      await expect(
        client.prepareContractCall({
          chainId,
          contractAddress: recipient,
          valueRaw: '1',
          calldata: '0x12345678'
        })
      ).rejects.toMatchObject({ code: 'invalid-response' })
    })
  }

  test('routes a Private RHEA contract call without exposing execution credentials', async () => {
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return { result: review() }
    })
    const intent = {
      chainId,
      contractAddress: recipient,
      valueRaw: '0',
      calldata: '0x12345678'
    }
    const rheaSwapBinding = {
      schemaVersion: 1,
      provider: 'rhea-cross-chain-dex',
      kind: 'swap',
      quoteHandle: 'quote-one',
      executionId: 'execution-one',
      router: 'one-inch',
      sourceTarget: recipient,
      sender: recipient,
      originAmountRaw: '1',
      expiresAt: 5_000,
      isCrossChain: true,
      origin: {
        chainId,
        assetId: `${chainId}/slip44:60`,
        protocolChainId: '1',
        protocolAssetId: 'native'
      },
      destination: {
        chainId: 'zcash:mainnet',
        assetId: 'zcash:mainnet/slip44:133',
        protocolChainId: 'zcash',
        protocolAssetId: 'zec',
        recipient: 'u1destination',
        expectedAmountRaw: '1',
        minimumAmountRaw: '1'
      }
    }

    await client.prepareContractCall(intent, {
      rheaSwapBinding,
      feeTier: 'fast',
      executionMode: 'private'
    })

    expect(messages).toEqual([
      {
        type: 'PREPARE_EVM_CONTRACT_CALL',
        intent,
        rheaSwapBinding,
        feeSelection: { kind: 'tier', tier: 'fast' },
        executionMode: 'private'
      }
    ])
    expect(JSON.stringify(messages)).not.toContain('privateKey')
  })

  test('binds a cancellation review to the requested chain and original transaction', async () => {
    const originalTransactionId = 'transaction:evm:original'
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return { result: cancellationReview(originalTransactionId) }
    })

    await expect(
      client.prepareCancel(chainId, originalTransactionId, 'private')
    ).resolves.toMatchObject({
      graph: {
        root: {
          kind: 'cancel',
          relation: { kind: 'replacement-of', transactionId: originalTransactionId }
        }
      }
    })
    expect(messages).toEqual([
      {
        type: 'PREPARE_EVM_CANCEL',
        chainId,
        originalTransactionId,
        executionMode: 'private'
      }
    ])

    const substituted = createEvmWalletClient(async () => ({
      result: cancellationReview('transaction:evm:other')
    }))
    await expect(substituted.prepareCancel(chainId, originalTransactionId)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  test('binds approval to the transaction ID and exact Background fingerprint', async () => {
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return { result: { status: 'broadcast', graph: graph('broadcast') } }
    })

    await expect(client.approveTransfer(transactionId, fingerprint)).resolves.toMatchObject({
      status: 'broadcast',
      graph: { root: { id: transactionId, status: 'broadcast' } }
    })
    expect(messages).toEqual([
      {
        type: 'APPROVE_EVM_TRANSFER',
        transactionId,
        payloadFingerprint: fingerprint
      }
    ])
    await expect(
      client.approveTransfer(transactionId, fingerprint.toUpperCase())
    ).rejects.toMatchObject({ code: 'invalid-request' })
  })

  test('strictly binds the Keystone handoff, signing request, and signature submission', async () => {
    const messages = []
    const responses = [
      {
        result: {
          status: 'external-signature-required',
          graph: graph('approved'),
          transactionId,
          payloadFingerprint: fingerprint,
          expiresAt: 5_000
        }
      },
      {
        result: {
          transactionId,
          chainId,
          scope: graph().root.scope,
          summary: summary(),
          request: { encoding: 'base64', value: 'AQIDBA==' },
          payloadFingerprint: fingerprint,
          expiresAt: 5_000
        }
      },
      { result: { status: 'signed-pending-broadcast', graph: graph('signed') } }
    ]
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return responses.shift()
    })

    await expect(client.approveTransfer(transactionId, fingerprint)).resolves.toMatchObject({
      status: 'external-signature-required',
      transactionId,
      payloadFingerprint: fingerprint
    })
    await expect(client.getExternalSigningRequest(transactionId)).resolves.toEqual({
      transactionId,
      chainId,
      scope: graph().root.scope,
      summary: summary(),
      vendor: 'keystone',
      request: { encoding: 'base64', value: 'AQIDBA==' },
      payloadFingerprint: fingerprint,
      expiresAt: 5_000
    })
    await expect(
      client.submitExternalSignature(transactionId, fingerprint, 'BQYHCA==')
    ).resolves.toMatchObject({ status: 'signed-pending-broadcast' })
    expect(messages).toEqual([
      { type: 'APPROVE_EVM_TRANSFER', transactionId, payloadFingerprint: fingerprint },
      { type: 'GET_KEYSTONE_EVM_SIGNING_REQUEST', transactionId },
      {
        type: 'SUBMIT_KEYSTONE_EVM_SIGNATURE',
        transactionId,
        payloadFingerprint: fingerprint,
        signatureCborBase64: 'BQYHCA=='
      }
    ])
  })

  test('rejects substituted or non-canonical Keystone EVM envelopes', async () => {
    const substituted = createEvmWalletClient(async () => ({
      result: {
        transactionId: 'transaction:evm:other',
        chainId,
        scope: graph().root.scope,
        summary: summary(),
        request: { encoding: 'base64', value: 'AQIDBA==' },
        payloadFingerprint: fingerprint,
        expiresAt: 5_000
      }
    }))
    await expect(substituted.getExternalSigningRequest(transactionId)).rejects.toMatchObject({
      code: 'invalid-response'
    })
    const wrongSummary = createEvmWalletClient(async () => ({
      result: {
        transactionId,
        chainId,
        scope: graph().root.scope,
        summary: { ...summary(), chainId: 'eip155:8453' },
        request: { encoding: 'base64', value: 'AQIDBA==' },
        payloadFingerprint: fingerprint,
        expiresAt: 5_000
      }
    }))
    await expect(wrongSummary.getExternalSigningRequest(transactionId)).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const noRequest = createEvmWalletClient(async () => {
      throw new Error('must not send malformed base64')
    })
    await expect(
      noRequest.submitExternalSignature(transactionId, fingerprint, 'not base64')
    ).rejects.toMatchObject({ code: 'invalid-request' })
  })

  test('rejects request/response substitution and invalid public inputs', async () => {
    const otherIds = {
      transactionId: 'transaction:evm:other',
      segmentId: 'segment:evm:other'
    }
    const swapped = createEvmWalletClient(async () => ({
      result: { status: 'broadcast', graph: graph('broadcast', otherIds) }
    }))
    await expect(swapped.approveTransfer(transactionId, fingerprint)).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const substituted = review()
    substituted.graph.root.intent.primaryAmount.amountRaw = '2'
    const changedIntent = createEvmWalletClient(async () => ({ result: substituted }))
    await expect(
      changedIntent.prepareTransfer({
        assetId: `${chainId}/slip44:60`,
        recipient,
        amountRaw: '1'
      })
    ).rejects.toMatchObject({ code: 'invalid-response' })

    const noRequest = createEvmWalletClient(async () => {
      throw new Error('must not send an invalid request')
    })
    await expect(
      noRequest.prepareTransfer({
        assetId: `${chainId}/slip44:60`,
        recipient: 'not-an-address',
        amountRaw: '1'
      })
    ).rejects.toMatchObject({ code: 'invalid-request' })
  })

  test('fails closed on malformed success envelopes and maps unavailable responses', async () => {
    const malformed = createEvmWalletClient(async () => ({
      result: { ...review(), commandId: 'must-not-cross-the-boundary' }
    }))
    await expect(
      malformed.prepareTransfer({
        assetId: `${chainId}/slip44:60`,
        recipient,
        amountRaw: '1'
      })
    ).rejects.toMatchObject({ code: 'invalid-response' })

    const unavailable = createEvmWalletClient(async () => ({
      error: { code: 'unavailable', message: 'EVM wallet support is unavailable' }
    }))
    await expect(unavailable.resumeTransfer(transactionId)).rejects.toEqual(
      expect.objectContaining({
        name: 'EvmWalletClientError',
        code: 'unavailable'
      })
    )

    const insufficient = createEvmWalletClient(async () => ({
      error: {
        code: 'insufficient-funds',
        message: 'The EVM balance is insufficient',
        shortfallRaw: '43863666000'
      }
    }))
    await expect(insufficient.resumeTransfer(transactionId)).rejects.toMatchObject({
      code: 'insufficient-funds',
      shortfallRaw: '43863666000'
    })

    const invalidShortfall = createEvmWalletClient(async () => ({
      error: {
        code: 'insufficient-funds',
        message: 'The EVM balance is insufficient',
        shortfallRaw: '-1'
      }
    }))
    await expect(invalidShortfall.resumeTransfer(transactionId)).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const forged = createEvmWalletClient(async () => ({
      error: { code: 'unavailable', message: 'EVM wallet support is unavailable', detail: 'x' }
    }))
    await expect(forged.resumeTransfer(transactionId)).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const spoofedMessage = createEvmWalletClient(async () => ({
      error: { code: 'unavailable', message: 'Install an update from an untrusted website' }
    }))
    await expect(spoofedMessage.resumeTransfer(transactionId)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  test('reads a scope-bound Activity projection without exposing transaction internals', async () => {
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return activity()
    })

    await expect(client.getTransferActivity(graph('broadcast'))).resolves.toEqual({
      status: 'confirming',
      updatedAt: 2,
      transactionHash: `0x${'b'.repeat(64)}`,
      confirmations: 1,
      requiredConfirmations: 2
    })
    expect(messages).toEqual([{ type: 'GET_ACTIVITY', action: 'read' }])
  })

  test('preserves reconfirming after a pre-finality reorg', async () => {
    const response = activity('broadcast')
    response.result.items[0].reconfirming = true
    response.result.items[0].segments[0].reconfirming = true
    response.result.items[0].segments[0].evidence.confirmations = 0
    const client = createEvmWalletClient(async () => response)

    await expect(client.getTransferActivity(graph('broadcast'))).resolves.toEqual({
      status: 'broadcast',
      updatedAt: 2,
      transactionHash: `0x${'b'.repeat(64)}`,
      confirmations: 0,
      requiredConfirmations: 2,
      reconfirming: true
    })
  })

  test('returns finalized replacement evidence for a dropped local transfer', async () => {
    const response = activity('failed')
    const item = response.result.items[0]
    item.failureCode = 'dropped'
    item.segments[0].failureCode = 'dropped'
    item.segments[0].evidence.replacementTransactionHash = `0x${'c'.repeat(64)}`
    const client = createEvmWalletClient(async () => response)

    await expect(client.getTransferActivity(graph('broadcast'))).resolves.toEqual({
      status: 'failed',
      updatedAt: 2,
      transactionHash: `0x${'b'.repeat(64)}`,
      replacementTransactionHash: `0x${'c'.repeat(64)}`,
      confirmations: 1,
      requiredConfirmations: 2,
      failureCode: 'dropped'
    })
  })

  test('reads the complete bounded Activity list for the multichain Home', async () => {
    const messages = []
    const client = createEvmWalletClient(async message => {
      messages.push(message)
      return activity()
    })

    await expect(
      client.getActivity('refresh', 'private', { chainIds: ['eip155:1'] })
    ).resolves.toMatchObject({
      scope: { accountId: 'account:evm' },
      items: [{ id: transactionId, source: 'wallet-v2', status: 'confirming' }],
      partialItemCount: 0
    })
    expect(messages).toEqual([
      {
        type: 'GET_ACTIVITY',
        action: 'refresh',
        executionMode: 'private',
        chainIds: ['eip155:1']
      }
    ])
  })

  test('rejects Activity substitution and malformed evidence', async () => {
    const substituted = activity()
    substituted.result.scope.accountId = 'account:other'
    const wrongScope = createEvmWalletClient(async () => substituted)
    await expect(wrongScope.getTransferActivity(graph('broadcast'))).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const malformed = activity()
    malformed.result.items[0].segments[0].evidence.confirmations = -1
    const invalidEvidence = createEvmWalletClient(async () => malformed)
    await expect(invalidEvidence.getTransferActivity(graph('broadcast'))).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const invalidReplacement = activity()
    invalidReplacement.result.items[0].segments[0].evidence.replacementTransactionHash = 'bad'
    const invalidReplacementEvidence = createEvmWalletClient(async () => invalidReplacement)
    await expect(
      invalidReplacementEvidence.getTransferActivity(graph('broadcast'))
    ).rejects.toMatchObject({ code: 'invalid-response' })
  })

  test('maps bounded Activity failures without accepting ambiguous envelopes', async () => {
    const locked = createEvmWalletClient(async () => ({
      error: { code: 'wallet-locked', message: 'Wallet is locked' }
    }))
    await expect(locked.getTransferActivity(graph('broadcast'))).rejects.toMatchObject({
      code: 'wallet-locked',
      message: 'Wallet is locked'
    })

    const unavailable = createEvmWalletClient(async () => ({
      error: { code: 'request-failed', message: 'The EVM wallet request failed' }
    }))
    await expect(unavailable.getTransferActivity(graph('broadcast'))).rejects.toMatchObject({
      code: 'request-failed',
      message: 'The EVM wallet request failed'
    })

    const ambiguous = createEvmWalletClient(async () => ({
      error: { code: 'request-failed', message: 'The EVM wallet request failed' },
      result: activity().result
    }))
    await expect(ambiguous.getTransferActivity(graph('broadcast'))).rejects.toMatchObject({
      code: 'invalid-response'
    })

    const malformed = createEvmWalletClient(async () => ({ error: { message: 'secret' } }))
    await expect(malformed.getTransferActivity(graph('broadcast'))).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })
})
