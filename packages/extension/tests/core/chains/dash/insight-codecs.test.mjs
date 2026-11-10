import { test } from 'node:test'
import { expect } from '@playwright/test'
import bs58check from 'bs58check'

import { getDashNetworkConfig } from '../../../../src/config/networks.ts'
import { DASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import { parseChainEndpointSettings } from '../../../../src/core/chains/chain-endpoint-settings.ts'
import {
  DASH_INSIGHT_MAX_ADDRESSES,
  DASH_MAX_RELAY_FEE_DUFFS_PER_KB,
  DASH_MIN_RELAY_FEE_DUFFS_PER_KB,
  estimateDashLegacyFeeDuffs,
  parseDashDecimalToDuffs,
  resolveDashRelayFeeDuffsPerKb
} from '../../../../src/infrastructure/chains/dash/config.ts'
import {
  DashRpcError,
  parseDashInsightStatus,
  readJsonScalarLiteral
} from '../../../../src/infrastructure/chains/dash/dash-insight-codecs.ts'
import {
  createDashInsightClient
} from '../../../../src/infrastructure/chains/dash/dash-insight-client.ts'
import { createDashInsightFailoverClient } from '../../../../src/infrastructure/chains/dash/dash-insight-failover-client.ts'
import { buildRpcChainOptions } from '../../../../src/popup/services/chain-settings-options.ts'
import { DEFAULT_CHAIN_ENDPOINT_SETTINGS } from '../../../../src/core/chains/chain-endpoint-settings.ts'

const MAINNET = DASH_CHAIN_IDS.mainnet
const TESTNET = DASH_CHAIN_IDS.testnet
const MAINNET_GENESIS = getDashNetworkConfig('mainnet').genesisHash
const TESTNET_GENESIS = getDashNetworkConfig('testnet').genesisHash
const TESTNET_ADDRESS = 'ygwNQgE5f15Ygopbs2KPRYMS4TcffqBpsz'
const TXID = '3e81723d069b12983b2ef694c9782d32fca26cc978de744acbc32c3d3496e915'
const BLOCK_HASH = '00000000011a135e5277f5493c52c66829792392632b8b65429cf07ad3c47a6c'

function jsonResponse(value, init = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

function scriptedFetch(handlers, requests = []) {
  let index = 0
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init })
      const handler = handlers[index]
      index += 1
      if (!handler) throw new Error(`Unexpected request ${url}`)
      return handler(url, init)
    }
  }
}

function statusBody({
  network,
  testnet,
  relayfee = '0.00001',
  blocks = 2_300_000,
  errors = ''
}) {
  return JSON.stringify({
    info: {
      version: 200100,
      insightversion: '5.0.0',
      protocolversion: 70231,
      blocks,
      timeoffset: 0,
      connections: 8,
      proxy: '',
      difficulty: 86.2,
      testnet,
      relayfee: '__RELAY__',
      errors,
      network
    }
  }).replace('"__RELAY__"', relayfee)
}

function insightTransaction() {
  return {
    txid: TXID,
    version: 1,
    locktime: 0,
    vin: [
      {
        txid: '05d70bc1c4cf1c3afefc3250480d733b5666b19cb1f629901ded82cb2d6263d1',
        vout: 0,
        sequence: 4294967295,
        n: 0,
        scriptSig: { hex: '00', asm: '0' },
        addr: TESTNET_ADDRESS,
        valueSat: 1194595,
        value: 0.01194595,
        doubleSpentTxID: null
      }
    ],
    vout: [
      {
        value: '0.01184595',
        n: 0,
        scriptPubKey: {
          hex: '76a914e22dc8acf5bb5624f4beef22fb2238f8479e183f88ac',
          asm: 'OP_DUP OP_HASH160',
          addresses: [TESTNET_ADDRESS],
          type: 'pubkeyhash'
        },
        spentTxId: null,
        spentIndex: null,
        spentHeight: null
      }
    ],
    blockhash: BLOCK_HASH,
    blockheight: 100000,
    confirmations: 109367,
    time: 1393659685,
    blocktime: 1393659685,
    valueOut: 0.01184595,
    size: 225,
    valueIn: 0.01194595,
    fees: 0.0001,
    txlock: false
  }
}

function mainnetStatus() {
  return statusBody({ network: 'livenet', testnet: false })
}

function liveInsightStatus({ network = 'livenet', testnet } = {}) {
  const info = {
    version: 220000,
    insightversion: '4.0.8',
    protocolversion: 70235,
    blocks: 2569724,
    timeoffset: 0,
    connections: 11,
    difficulty: 138838597.3736598,
    relayfee: 0.00001,
    errors: '',
    network
  }
  if (testnet !== undefined) info.testnet = testnet
  return JSON.stringify({ info })
}

test('converts relay fees in integer duffs without binary floating point', () => {
  expect(DASH_MIN_RELAY_FEE_DUFFS_PER_KB).toBe(1000n)
  expect(parseDashDecimalToDuffs('0.00001')).toBe(1000n)
  expect(resolveDashRelayFeeDuffsPerKb('0.00001')).toBe(1000n)
  expect(parseDashDecimalToDuffs('0000.00001000')).toBe(1000n)
  expect(parseDashDecimalToDuffs('00010.00000001')).toBe(1_000_000_001n)
  expect(parseDashDecimalToDuffs('1.99999999')).toBe(199_999_999n)
  expect(parseDashDecimalToDuffs('20999999.99999999')).toBe(2_099_999_999_999_999n)
  expect(resolveDashRelayFeeDuffsPerKb('0.00000001')).toBe(DASH_MIN_RELAY_FEE_DUFFS_PER_KB)
  expect(resolveDashRelayFeeDuffsPerKb('0.10000000')).toBe(DASH_MAX_RELAY_FEE_DUFFS_PER_KB)
  for (const value of ['', ' ', 'abc', 'NaN', '1e-5', '+0.00001', '-0.00001', '0.000010000', '.00001', '1.']) {
    expect(() => parseDashDecimalToDuffs(value)).toThrow(/Invalid Dash decimal amount/)
  }
  expect(() => resolveDashRelayFeeDuffsPerKb('0.10000001')).toThrow(/maximum/)
  expect(estimateDashLegacyFeeDuffs(250, 1000n)).toBe(250n)
  expect(estimateDashLegacyFeeDuffs(1, 1000n)).toBe(1n)
  expect(estimateDashLegacyFeeDuffs(1, 1001n)).toBe(2n)
  expect(estimateDashLegacyFeeDuffs(1001, 1000n)).toBe(1001n)
  expect(() => estimateDashLegacyFeeDuffs(1, 999n)).toThrow(/fee rate/)
})

test('reads the relay fee literal from an Insight getInfo document', () => {
  const body = mainnetStatus().replace('"errors":""', '"errors":"relayfee"')
  expect(JSON.parse(body).info.relayfee * 1e8).not.toBe(1000)
  expect(readJsonScalarLiteral(body, 'relayfee')).toBe('0.00001')
  expect(parseDashInsightStatus(body)).toMatchObject({
    blocks: 2_300_000,
    network: 'livenet',
    testnet: false,
    relayFeeDuffsPerKb: '1000'
  })
  expect(parseDashInsightStatus(statusBody({
    network: 'livenet',
    testnet: false,
    relayfee: '"0.00000001"'
  })).relayFeeDuffsPerKb).toBe('1000')
})

test('derives the testnet flag when current Insight omits proxy and testnet', () => {
  const mainnet = liveInsightStatus()
  expect(JSON.parse(mainnet).info).not.toHaveProperty('proxy')
  expect(JSON.parse(mainnet).info).not.toHaveProperty('testnet')
  expect(readJsonScalarLiteral(mainnet, 'relayfee')).toBe('0.00001')
  expect(parseDashInsightStatus(mainnet)).toMatchObject({
    blocks: 2569724,
    network: 'livenet',
    testnet: false,
    relayFeeDuffsPerKb: '1000'
  })
  expect(parseDashInsightStatus(liveInsightStatus({ network: 'testnet' }))).toMatchObject({
    network: 'testnet',
    testnet: true,
    relayFeeDuffsPerKb: '1000'
  })
  expect(() => parseDashInsightStatus(liveInsightStatus({ testnet: true }))).toThrow(DashRpcError)
  expect(() => parseDashInsightStatus(liveInsightStatus({ network: 'testnet', testnet: false }))).toThrow(
    DashRpcError
  )
})

test('attests genesis, tip, and network identity', async () => {
  expect(MAINNET).toBe(`bip122:${MAINNET_GENESIS.slice(0, 32)}`)
  expect(TESTNET).toBe(`bip122:${TESTNET_GENESIS.slice(0, 32)}`)
  const transport = scriptedFetch([
    () => jsonResponse({ blockHash: MAINNET_GENESIS }),
    () => jsonResponse(mainnetStatus())
  ])
  const client = createDashInsightClient(
    { chainId: MAINNET, baseUrl: 'https://insight.example/insight-api' },
    transport.fetch
  )

  await client.assertExpectedChain()
  expect(transport.requests.map(request => request.url)).toEqual([
    'https://insight.example/insight-api/block-index/0',
    'https://insight.example/insight-api/status?q=getInfo'
  ])
  expect(transport.requests[0].init).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer'
  })

  const wrongNetwork = scriptedFetch([
    () => jsonResponse({ blockHash: TESTNET_GENESIS }),
    () => jsonResponse(statusBody({ network: 'livenet', testnet: false }))
  ])
  const testnet = createDashInsightClient(
    { chainId: TESTNET, baseUrl: 'https://insight.example/insight-api/' },
    wrongNetwork.fetch
  )
  await expect(testnet.assertExpectedChain()).rejects.toMatchObject({
    code: 'chain-mismatch'
  })
})

test('reads UTXOs, paged transactions, raw transactions, and one network fee', async () => {
  const secondAddress = bs58check.encode(
    Uint8Array.from([getDashNetworkConfig('testnet').p2pkhVersion, 2, ...new Uint8Array(19)])
  )
  const transport = scriptedFetch([
    () =>
      jsonResponse([
        {
          address: TESTNET_ADDRESS,
          txid: '05d70bc1c4cf1c3afefc3250480d733b5666b19cb1f629901ded82cb2d6263d1',
          vout: 0,
          scriptPubKey: '76a914e22dc8acf5bb5624f4beef22fb2238f8479e183f88ac',
          amount: 0.01194595,
          satoshis: 1194595,
          height: 142204,
          confirmations: 124317
        }
      ]),
    () => jsonResponse({ pagesTotal: 1, txs: [insightTransaction()] }),
    () => jsonResponse({ rawtx: '01000000' }),
    (_url, init) => {
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
      expect(init.body).toBe('rawtx=01000000')
      return jsonResponse({
        txid: 'c7736a0a0046d5a8cc61c8c3c2821d4d7517f5de2bc66a966011aaa79965ffba'
      })
    },
    () => jsonResponse(statusBody({ network: 'testnet', testnet: true, blocks: 900 })),
    () => jsonResponse(statusBody({ network: 'testnet', testnet: true, blocks: 900 }))
  ])
  const client = createDashInsightClient(
    { chainId: TESTNET, baseUrl: 'https://insight.example/insight-api/' },
    transport.fetch
  )

  await expect(client.getAddressUtxos([TESTNET_ADDRESS, secondAddress])).resolves.toEqual([
    {
      address: TESTNET_ADDRESS,
      transactionId: '05d70bc1c4cf1c3afefc3250480d733b5666b19cb1f629901ded82cb2d6263d1',
      outputIndex: 0,
      scriptHex: '76a914e22dc8acf5bb5624f4beef22fb2238f8479e183f88ac',
      valueDuffs: '1194595',
      confirmations: 124317,
      height: 142204
    }
  ])
  expect(transport.requests[0].url).toBe(
    `https://insight.example/insight-api/addrs/${TESTNET_ADDRESS},${secondAddress}/utxo`
  )
  await expect(client.getAddressTransactions(TESTNET_ADDRESS, 0)).resolves.toMatchObject({
    pagesTotal: 1,
    transactions: [
      {
        transactionId: TXID,
        sizeBytes: 225,
        valueOutDuffs: '1184595',
        feeDuffs: '10000'
      }
    ]
  })
  expect(transport.requests[1].url).toBe(
    `https://insight.example/insight-api/txs?address=${TESTNET_ADDRESS}&pageNum=0`
  )
  await expect(client.getRawTransaction(TXID)).resolves.toBe('01000000')
  expect(transport.requests[2].url).toBe(`https://insight.example/insight-api/rawtx/${TXID}`)
  await expect(client.broadcastRawTransaction('01000000')).resolves.toBe(
    'c7736a0a0046d5a8cc61c8c3c2821d4d7517f5de2bc66a966011aaa79965ffba'
  )
  expect(transport.requests[3].url).toBe('https://insight.example/insight-api/tx/send')
  await expect(client.getTipHeight()).resolves.toBe(900)
  await expect(client.getNetworkFeeRate()).resolves.toBe('1000')
})

test('accepts a decimal amount string and rejects a bare JSON number', async () => {
  const transport = scriptedFetch([
    () =>
      jsonResponse([
        {
          address: TESTNET_ADDRESS,
          txid: TXID,
          vout: 1,
          scriptPubKey: '76a914e22dc8acf5bb5624f4beef22fb2238f8479e183f88ac',
          amount: '0.01194595',
          confirmations: 0,
          ts: 1461349425
        }
      ]),
    () =>
      jsonResponse([
        {
          address: TESTNET_ADDRESS,
          txid: TXID,
          vout: 1,
          scriptPubKey: 'aa',
          amount: 0.01194595,
          confirmations: 0
        }
      ])
  ])
  const client = createDashInsightClient(
    { chainId: TESTNET, baseUrl: 'https://insight.example/insight-api/' },
    transport.fetch
  )
  await expect(client.getAddressUtxos([TESTNET_ADDRESS])).resolves.toMatchObject([
    { valueDuffs: '1194595', timestamp: 1461349425 }
  ])
  await expect(client.getAddressUtxos([TESTNET_ADDRESS])).rejects.toBeInstanceOf(DashRpcError)
})

test('caps Insight address batches at the dashcore-node query limit', async () => {
  expect(DASH_INSIGHT_MAX_ADDRESSES).toBe(10_000)
  const requests = []
  const client = createDashInsightClient(
    { chainId: TESTNET, baseUrl: 'https://insight.example/insight-api/' },
    async url => {
      requests.push(url)
      throw new Error('fetch should not run')
    }
  )
  await expect(client.getAddressUtxos([])).rejects.toThrow(/requires an address/)
  await expect(
    client.getAddressUtxos(Array.from({ length: DASH_INSIGHT_MAX_ADDRESSES + 1 }, () => 'x'))
  ).rejects.toThrow(new RegExp(String(DASH_INSIGHT_MAX_ADDRESSES)))
  await expect(client.getAddressUtxos([TESTNET_ADDRESS, TESTNET_ADDRESS])).rejects.toThrow(
    /Duplicate/
  )
  expect(requests).toEqual([])
})

test('bounds the response body and the request deadline', async () => {
  const oversized = createDashInsightClient(
    {
      chainId: MAINNET,
      baseUrl: 'https://insight.example/insight-api/',
      maximumResponseBytes: 1024
    },
    async () => jsonResponse('x'.repeat(2048))
  )
  await expect(oversized.getTipHeight()).rejects.toMatchObject({ code: 'invalid-response' })

  const timedOut = createDashInsightClient(
    { chainId: MAINNET, baseUrl: 'https://insight.example/insight-api/', timeoutMs: 20 },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
  )
  await expect(timedOut.getTipHeight()).rejects.toMatchObject({ code: 'timeout' })
})

test('fails over a timed-out endpoint and keeps a chain mismatch terminal', async () => {
  const requests = []
  let calls = 0
  const fetch = async (url, init) => {
    requests.push(String(url))
    calls += 1
    if (String(url).includes('down.example')) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }
    if (String(url).endsWith('/block-index/0')) return jsonResponse({ blockHash: MAINNET_GENESIS })
    return jsonResponse(mainnetStatus())
  }
  const client = createDashInsightFailoverClient(
    {
      chainId: MAINNET,
      timeoutMs: 20,
      minimumRequestIntervalMs: 0,
      endpoints: [
        { id: 'down', baseUrl: 'https://down.example/insight-api' },
        { id: 'up', baseUrl: 'https://up.example/insight-api' }
      ]
    },
    { fetchImplementation: fetch }
  )
  await expect(client.getNetworkFeeRate()).resolves.toBe('1000')
  expect(requests.some(url => url.startsWith('https://up.example/'))).toBe(true)
  expect(calls).toBeGreaterThan(1)

  const mismatched = createDashInsightFailoverClient(
    {
      chainId: MAINNET,
      minimumRequestIntervalMs: 0,
      endpoints: [
        { id: 'wrong', baseUrl: 'https://wrong.example/insight-api' },
        { id: 'right', baseUrl: 'https://right.example/insight-api' }
      ]
    },
    {
      fetchImplementation: async () => jsonResponse({ blockHash: TESTNET_GENESIS })
    }
  )
  await expect(mismatched.assertExpectedChain()).rejects.toMatchObject({ code: 'chain-mismatch' })
})

test('keeps Dash RPC presets behind chain.dash', () => {
  const previous = globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__
  try {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash', 'chain.evm']
    expect(
      buildRpcChainOptions(DEFAULT_CHAIN_ENDPOINT_SETTINGS).some(
        option => option.protocol === 'dash-insight'
      )
    ).toBe(false)

    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = ['chain.zcash', 'chain.dash']
    expect(
      buildRpcChainOptions(DEFAULT_CHAIN_ENDPOINT_SETTINGS).find(
        option => option.protocol === 'dash-insight'
      )
    ).toMatchObject({
      chainId: MAINNET,
      label: 'Dash',
      iconChain: 'dash',
      defaultUrl: 'https://insight.dash.org/insight-api',
      presets: [
        {
          id: 'insight',
          label: 'Insight',
          url: 'https://insight.dash.org/insight-api'
        }
      ]
    })
  } finally {
    globalThis.__ENABLED_CHAIN_FEATURE_FLAGS__ = previous
  }
})

test('accepts a Dash Insight override only for the Dash chain', () => {
  expect(
    parseChainEndpointSettings({
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: [
        {
          chainId: MAINNET,
          rpc: {
            protocol: 'dash-insight',
            label: 'Insight',
            url: 'https://insight.dash.org/insight-api'
          }
        }
      ]
    }).overrides[0].rpc
  ).toMatchObject({ protocol: 'dash-insight' })
  expect(() =>
    parseChainEndpointSettings({
      schemaVersion: 1,
      customEvmNetworks: [],
      overrides: [
        {
          chainId: 'bip122:000000000019d6689c085ae165831e93',
          rpc: {
            protocol: 'dash-insight',
            label: 'Insight',
            url: 'https://insight.example/insight-api'
          }
        }
      ]
    })
  ).toThrow(/BIP-122/)
})
