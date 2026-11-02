import assert from 'node:assert/strict'
import { it } from 'node:test'
import { resolveConfidentialEvmAssetSupport } from '../../../../src/core/services/rhea-swap/rhea-confidential-support.ts'
import { resolveEvmAddressRole } from '../../../../src/core/accounts/evm-address-role.ts'
import {
  createEvmSendIntentKey,
  getEvmSendPrivacyWarning,
  resolveEvmSendAvailableRaw,
  resolveEvmSendRoute
} from '../../../../src/popup/services/evm-send-routing.ts'
import {
  evmSendCatalogRequest,
  loadEvmSendCatalog,
  prefetchEvmSendCatalogs
} from '../../../../src/popup/services/evm-send-catalog.ts'
import { createRheaSwapClient } from '../../../../src/popup/services/rhea-swap-client.ts'
import {
  createNativeTransferSource,
  estimateNativeTransferMaximum,
  estimateRheaRouteMaximum
} from '../../../../src/popup/services/transfer-maximum.ts'
import { createQuoteDepositTransferClient } from '../../../../src/popup/services/quote-deposit-transfer-client.ts'
import {
  MemoryRheaSwapQuoteSessionStore,
  RheaSwapService
} from '../../../../src/core/services/rhea-swap/rhea-swap-service.ts'
import { RheaSwapCatalogClient } from '../../../../src/core/services/rhea-swap/rhea-swap-catalog-client.ts'
import { createEvmWalletClient } from '../../../../src/popup/services/evm-wallet-client.ts'

const chain = { id: 'eip155:1', family: 'evm', network: { kind: 'mainnet' } }
const contract = `0x${'ab'.repeat(20)}`
const pea = `0x${'1'.repeat(40)}`
const main = `0x${'2'.repeat(40)}`
const recipient = `0x${'3'.repeat(40)}`
const native = { id: `${chain.id}/slip44:60`, chainId: chain.id, kind: 'native', reference: '60' }
const erc20 = {
  id: `${chain.id}/erc20:${contract}`,
  chainId: chain.id,
  kind: 'token',
  reference: contract
}
const token = (overrides = {}) => ({
  assetId: 'nep141:eth.omft.near',
  blockchain: 'eth',
  contractAddress: null,
  decimals: 18,
  icon: null,
  price: 1,
  priceUpdatedAt: '2026-10-26T00:00:00Z',
  symbol: 'ETH',
  rheaChainId: '1',
  tokenListChainId: 1,
  rheaAddress: 'native',
  isNative: true,
  sources: ['nearintents'],
  ...overrides
})
const catalog = (...tokens) => ({ tokens, failedChainIds: [] })
const support = (value, asset = native, network = chain) =>
  resolveConfidentialEvmAssetSupport({ chain: network, asset, catalog: value })

it('distinguishes explicit support, explicit exclusion, and unknown capability metadata', () => {
  assert.equal(support(catalog(token())), 'supported')
  assert.equal(support(catalog(token({ sources: ['preswap-nearintents'] }))), 'supported')
  assert.equal(support(catalog(token({ sources: ['lifi'] }))), 'unsupported')
  assert.equal(support(catalog(token({ sources: [] }))), 'unknown')
  assert.equal(support(catalog(token()), erc20), 'unsupported')
  for (const value of [null, catalog(), { ...catalog(token()), failedChainIds: [1] }]) {
    assert.equal(support(value), 'unknown')
  }
})

it('matches contracts case-insensitively, never by symbol, catalog ID, or another network', () => {
  const row = token({
    isNative: false,
    contractAddress: contract.toUpperCase().replace('0X', '0x'),
    rheaAddress: contract,
    symbol: 'ETH'
  })
  assert.equal(support(catalog(row), erc20), 'supported')
  assert.equal(support(catalog(row), native), 'unsupported')
  assert.equal(support(catalog(token({ contractAddress: contract })), erc20), 'unsupported')
  assert.equal(support(catalog({ ...row, contractAddress: null }), erc20), 'supported')
  for (const overrides of [
    { rheaChainId: '56' },
    { tokenListChainId: 56 },
    { contractAddress: null, rheaAddress: 'catalog-only-id' }
  ]) {
    assert.equal(support(catalog({ ...row, ...overrides }), erc20), 'unknown')
  }
  assert.equal(support(catalog(token()), { ...native, chainId: 'eip155:56' }), 'unknown')
  assert.equal(
    support(null, native, { ...chain, id: 'eip155:11155111', network: { kind: 'testnet' } }),
    'unsupported'
  )
  assert.equal(support(null, native, { ...chain, id: 'eip155:999999' }), 'unsupported')
})

it('retains usable rows while marking a malformed catalog as partial', async () => {
  const row = { ...token(), chain: '1', address: 'native', raw: {} }
  const service = new RheaSwapService(
    { getFromTokens: async () => [row, { ...row, tokenListChainId: 999999 }] },
    new MemoryRheaSwapQuoteSessionStore()
  )
  const result = await service.listTokens({ direction: 'from', tokenListChainIds: [1] })
  assert.equal(result.tokens.length, 1)
  assert.deepEqual(result.failedChainIds, [1])
  assert.equal(support(result), 'unknown')
})

it('derives address roles from chain-scoped local identities and gives PEA precedence', () => {
  const accounts = [
    {
      networks: [
        { chain, addresses: [{ value: main }, { value: pea }], privateExecutionAddress: pea }
      ]
    }
  ]
  assert.equal(
    resolveEvmAddressRole(main.toUpperCase().replace('0X', '0x'), chain.id, accounts),
    'public'
  )
  assert.equal(resolveEvmAddressRole(pea, chain.id, accounts), 'confidential')
  assert.equal(resolveEvmAddressRole(recipient, chain.id, accounts), 'unknown')
  assert.equal(resolveEvmAddressRole(main, 'eip155:56', accounts), 'unknown')
  assert.equal(resolveEvmAddressRole(main, chain.id), 'unknown')
  assert.equal(getEvmSendPrivacyWarning('main', 'public'), null)
  for (const role of ['confidential', 'unknown']) assert.ok(getEvmSendPrivacyWarning('main', role))
  for (const role of ['public', 'confidential', 'unknown'])
    assert.match(getEvmSendPrivacyWarning('private', role), /direct on-chain/)
})

it('chooses the route before any quote and keeps unknown private assets blocked', () => {
  for (const state of ['supported', 'unsupported', 'unknown'])
    assert.equal(resolveEvmSendRoute('main', state), 'onchain')
  assert.equal(resolveEvmSendRoute('private', 'supported'), 'confidential')
  assert.equal(resolveEvmSendRoute('private', 'unsupported'), 'onchain')
  assert.equal(resolveEvmSendRoute('private', 'unknown'), 'pending')
})

it('spends only the selected source on-chain balance, including when the abstract aggregate is larger', () => {
  const balance = {
    availableRaw: '99999',
    mainRaw: '2000',
    privateRaw: '97000',
    privateOnchainRaw: '1000',
    confidentialRaw: '96000'
  }
  assert.equal(resolveEvmSendAvailableRaw(balance, 'main'), '2000')
  assert.equal(resolveEvmSendAvailableRaw(balance, 'private'), '1000')
  const { privateOnchainRaw, ...legacy } = balance
  assert.equal(resolveEvmSendAvailableRaw(legacy, 'private'), '0')
})

it('binds the reviewed payload to account, network, source, asset, recipient, amount, and route', () => {
  const input = {
    contextKey: JSON.stringify([
      'wallet:1',
      'account:1',
      'mainnet',
      'rpc',
      chain.id,
      'private',
      pea
    ]),
    assetId: native.id,
    assetReference: native.reference,
    decimals: 18,
    route: 'onchain',
    recipientRole: 'unknown',
    recipient,
    amountRaw: '100'
  }
  const frozen = createEvmSendIntentKey(input)
  for (const [field, value] of Object.entries({
    contextKey: 'another-account-network-or-source',
    assetId: erc20.id,
    assetReference: contract,
    decimals: 6,
    route: 'confidential',
    recipientRole: 'public',
    recipient: main,
    amountRaw: '101'
  })) {
    assert.notEqual(createEvmSendIntentKey({ ...input, [field]: value }), frozen)
  }
  assert.equal(createEvmSendIntentKey({ ...input }), frozen)
})

it('accepts a same-address transfer review while rejecting a falsely marked self transfer', async () => {
  const transactionId = 'transaction:evm:self'
  const segmentId = 'segment:evm:self'
  const value = {
    graph: {
      root: {
        id: transactionId,
        scope: { keyDomainId: 'key-domain:test', accountId: 'account:test' },
        kind: 'transfer',
        status: 'prepared',
        segmentIds: [segmentId],
        createdAt: 1,
        updatedAt: 1,
        revision: 0,
        intent: {
          schemaVersion: 1,
          direction: 'self',
          primaryAmount: { assetId: native.id, amountRaw: '1' },
          feeLimit: { assetId: native.id, amountRaw: '63000' },
          sender: { chainId: chain.id, address: main },
          recipient: { chainId: chain.id, address: main }
        }
      },
      segments: [
        {
          id: segmentId,
          transactionId,
          role: 'origin',
          target: { kind: 'onchain', chainId: chain.id },
          status: 'prepared',
          requiredForFinality: true,
          dependsOn: [],
          createdAt: 1,
          updatedAt: 1,
          revision: 0
        }
      ]
    },
    review: {
      chainId: chain.id,
      operation: 'transaction',
      expiresAt: 5000,
      payloadFingerprint: { algorithm: 'sha256', digestHex: 'a'.repeat(64) },
      summary: {
        schema: 'evm.transaction.v1',
        chainId: chain.id,
        operation: 'transaction',
        review: { level: 'standard', issues: [] },
        fields: {
          transactionType: 'eip1559',
          from: main,
          to: main,
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
  }
  const client = createEvmWalletClient(async () => ({ result: structuredClone(value) }))
  const prepared = await client.prepareTransfer({
    assetId: native.id,
    recipient: main,
    amountRaw: '1'
  })
  assert.equal(prepared.graph.root.intent.direction, 'self')
  value.graph.root.intent.sender.address = pea
  await assert.rejects(
    client.prepareTransfer({ assetId: native.id, recipient: main, amountRaw: '1' }),
    error => error.code === 'invalid-response'
  )
})

it('normalizes and shares ten-minute Send catalogs while allowing a forced retry', async () => {
  let now = 0
  let requests = 0
  const client = createRheaSwapClient(
    async () => {
      requests++
      return { result: catalog(token()) }
    },
    { now: () => now }
  )
  const request = { ...evmSendCatalogRequest(chain), tokenListChainIds: [10, 1] }
  const normalized = { ...request, tokenListChainIds: [1, 10] }
  const [first, second] = await Promise.all([
    client.listTokens(request),
    client.listTokens(normalized)
  ])
  assert.deepEqual(first, second)
  assert.equal(requests, 1)
  assert.deepEqual(client.readCachedTokens(normalized), first)
  assert.equal(support(first), 'supported')
  await client.listTokens(normalized)
  assert.equal(requests, 1)
  now = 10 * 60 * 1000
  assert.equal(client.readCachedTokens(request), null)
  await client.listTokens(normalized)
  assert.equal(requests, 2)
  await client.listTokens(request, { bypassCache: true })
  assert.equal(requests, 3)
})

it('does not cache partial/empty catalogs and lets a retry recover', async () => {
  const results = [{ ...catalog(token()), failedChainIds: [10] }, catalog(), catalog(token())]
  const client = createRheaSwapClient(async () => ({ result: results.shift() }))
  const request = { ...evmSendCatalogRequest(chain), tokenListChainIds: [1, 10] }
  for (let i = 0; i < 2; i++) {
    await client.listTokens(request)
    assert.equal(client.readCachedTokens(request), null)
  }
  await client.listTokens(request)
  assert.equal(support(client.readCachedTokens(request)), 'supported')
})

it('does not let SDK row filtering prove exclusion or cache an empty/metadata-incomplete response', async () => {
  let calls = 0
  let now = 0
  const row = {
    assetId: 'nep141:eth.omft.near',
    address: 'native',
    symbol: 'ETH',
    decimals: 18,
    isNative: true,
    price: 1,
    sources: ['nearintents']
  }
  const responses = [
    { native: row, malformed: { symbol: 'BROKEN' } },
    {},
    { native: { ...row, sources: [] } },
    { native: row }
  ]
  const client = new RheaSwapCatalogClient({
    baseUrl: 'https://catalog.example',
    now: () => now,
    retry: { maxRetries: 0 },
    fetch: async () => {
      calls++
      return new Response(
        JSON.stringify({ code: 0, msg: 'success', data: responses.shift() ?? { native: row } }),
        { headers: { 'content-type': 'application/json' } }
      )
    }
  })
  const service = new RheaSwapService(client, new MemoryRheaSwapQuoteSessionStore())
  const request = { direction: 'from', tokenListChainIds: [1] }
  assert.equal(support(await service.listTokens(request)), 'unknown')
  assert.equal(support(await service.listTokens(request)), 'unknown')
  assert.equal(support(await service.listTokens(request)), 'unknown')
  const supported = await service.listTokens(request)
  assert.equal(support(supported), 'supported')
  await service.listTokens(request)
  assert.equal(calls, 4)
  now = 600_000
  await service.listTokens(request)
  assert.equal(calls, 5)
})

it('ignores a previous context completion after switching account, network, or asset', async () => {
  let finish
  let current = 'old'
  const applied = []
  const pending = loadEvmSendCatalog(
    evmSendCatalogRequest(chain),
    () => current === 'old',
    () => applied.push('old'),
    {
      listTokens: () =>
        new Promise(resolve => {
          finish = resolve
        })
    }
  )
  current = 'new'
  await loadEvmSendCatalog(
    evmSendCatalogRequest(chain),
    () => current === 'new',
    () => applied.push('new'),
    { listTokens: async () => catalog(token()) }
  )
  finish(catalog(token()))
  await pending
  assert.deepEqual(applied, ['new'])
})

it('prefetches the preferred network first with at most two in-flight requests', async () => {
  let active = 0
  let maximum = 0
  const seen = []
  const networks = [
    chain,
    { ...chain, id: 'eip155:56' },
    { ...chain, id: 'eip155:137' },
    { ...chain, id: 'eip155:999999' }
  ]
  await prefetchEvmSendCatalogs(networks, 'eip155:137', () => false, {
    listTokens: async request => {
      seen.push(request.tokenListChainIds[0])
      maximum = Math.max(maximum, ++active)
      await Promise.resolve()
      active--
      return catalog(token())
    }
  })
  assert.equal(seen[0], 137)
  assert.equal(maximum, 2)
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [1, 56, 137]
  )
})

it('prepares native and ERC-20 direct Max probes from PEA without a privacy quote or approval', async () => {
  for (const definition of [native, erc20]) {
    const calls = []
    const asset = {
      asset: definition,
      metadata: { decimals: 18, symbol: 'TEST' },
      balance: { availableRaw: '99999', mainRaw: '2000', privateOnchainRaw: '1000' }
    }
    const source = createNativeTransferSource({
      asset,
      chain: { chain },
      sender: pea,
      availableRaw: resolveEvmSendAvailableRaw(asset.balance, 'private')
    })
    const client = createQuoteDepositTransferClient({
      evm: {
        prepareTransfer: async (intent, options) => {
          calls.push({ intent, options })
          return {
            graph: { root: { id: 'tx:probe' } },
            review: {
              summary: { schema: 'evm.transaction.v1', fields: { from: pea, maximumFeeWei: '100' } }
            }
          }
        },
        rejectTransfer: async id => calls.push({ rejected: id }),
        approveTransfer: async () => assert.fail('Max cannot submit')
      }
    })
    const result = await estimateNativeTransferMaximum(
      { source, recipient, executionMode: 'private' },
      client
    )
    assert.equal(source.refundAddress, pea)
    assert.equal(calls[0].options.executionMode, 'private')
    assert.equal(calls[0].intent.assetId, definition.id)
    assert.equal(calls[0].intent.recipient, recipient)
    assert.equal(result.amountRaw, definition.kind === 'native' ? '875' : '1000')
    assert.equal(calls.length, 2)
  }
})

it('propagates a supported Confidential quote failure without preparing any direct transfer', async () => {
  let nativeCalls = 0
  const asset = {
    asset: native,
    metadata: { decimals: 18, symbol: 'ETH' },
    balance: { availableRaw: '1000' }
  }
  await assert.rejects(
    estimateRheaRouteMaximum(
      {
        source: createNativeTransferSource({
          asset,
          chain: { chain },
          sender: pea,
          availableRaw: '1000'
        }),
        tokenIn: token(),
        tokenOut: token(),
        recipient,
        confidential: true,
        executionMode: 'private'
      },
      {
        rhea: {
          quote: async request => {
            assert.equal(request.confidentiality, 'basic')
            throw new Error('quote unavailable')
          }
        },
        transfer: {
          estimateMaximum: async () => {
            nativeCalls++
            assert.fail('No native fallback')
          }
        }
      }
    ),
    /quote unavailable/
  )
  assert.equal(nativeCalls, 0)
})
