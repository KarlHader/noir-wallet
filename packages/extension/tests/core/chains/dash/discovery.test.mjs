import { test } from 'node:test'
import { expect } from '@playwright/test'
import bs58check from 'bs58check'

import { DASH_CHAIN_IDS } from '../../../../src/core/chains/registry/chain-ids.ts'
import { buildPortfolioReadModel } from '../../../../src/core/portfolio/portfolio-read-model.ts'
import {
  createAssetRegistry,
  createInitialProductChainRegistry,
  getBundledInitialProductAssetDefinitions
} from '../../../../src/core/chains/registry/index.ts'
import { DASH_COINBASE_MATURITY, DASH_GAP_LIMIT, DASH_LOOKAHEAD_ADDRESSES } from '../../../../src/infrastructure/chains/dash/config.ts'
import { DashRpcError, parseDashAddressTransactions, parseDashTransaction, parseDashUtxos } from '../../../../src/infrastructure/chains/dash/dash-insight-codecs.ts'
import { DashDiscoveryCoordinator } from '../../../../src/infrastructure/chains/dash/dash-discovery-coordinator.ts'
import { dashCurrentReceiveAddress } from '../../../../src/infrastructure/chains/dash/dash-discovery-model.ts'
import { MemoryDashDiscoveryRepository } from '../../../../src/infrastructure/chains/dash/dash-discovery-repository.ts'
import { DashDiscoveryError, DashGapLimitScanner } from '../../../../src/infrastructure/chains/dash/dash-gap-limit-scanner.ts'
import { MemoryDashInputReservationRepository } from '../../../../src/infrastructure/chains/dash/dash-input-reservation-repository.ts'
import { DashPortfolioCoordinator } from '../../../../src/infrastructure/chains/dash/dash-portfolio-coordinator.ts'
import { collectDashSpendableUtxos } from '../../../../src/infrastructure/chains/dash/dash-spendable-utxos.ts'

const PUBLIC_KEY = `0x02${'11'.repeat(32)}`
const chains = createInitialProductChainRegistry('testnet')
const assets = createAssetRegistry(chains, getBundledInitialProductAssetDefinitions('testnet'))

function p2pkh(version, index) {
  const hash = Buffer.alloc(20)
  hash[0] = index
  hash[1] = version
  const payload = Buffer.concat([Buffer.from([version]), hash])
  return Object.freeze({
    address: bs58check.encode(payload),
    script: `76a914${hash.toString('hex')}88ac`
  })
}

function txid(index) {
  return index.toString(16).padStart(64, '0')
}

function decimalDuffs(duffs) {
  const whole = duffs / 100_000_000n
  const fraction = (duffs % 100_000_000n).toString().padStart(8, '0')
  return `${whole.toString()}.${fraction}`
}

function insightTransaction({
  id,
  address,
  script,
  duffs = 100_000_000n,
  confirmations = 6,
  type,
  coinbase = false
}) {
  return {
    txid: txid(id),
    version: 1,
    locktime: 0,
    vin: coinbase
      ? [{ coinbase: '00', sequence: 4294967295, n: 0 }]
      : [
          {
            txid: txid(9_000 + id),
            vout: 0,
            sequence: 4294967295,
            n: 0,
            valueSat: 200_000_000
          }
        ],
    vout: [
      {
        value: decimalDuffs(duffs),
        n: 0,
        scriptPubKey: { hex: script },
        spentTxId: null,
        spentIndex: null,
        spentHeight: null
      }
    ],
    blockhash: confirmations > 0 ? 'ab'.repeat(32) : null,
    blockheight: confirmations > 0 ? 1_000 : -1,
    confirmations,
    time: 1_700_000_000,
    valueOut: 1,
    size: 200,
    txlock: false,
    ...(type === undefined ? {} : { type }),
    ...(coinbase ? { isCoinBase: true } : {})
  }
}

function utxo(address, id, script, duffs, confirmations) {
  const value = {
    address,
    txid: txid(id),
    vout: 0,
    scriptPubKey: script,
    amount: decimalDuffs(duffs),
    satoshis: Number(duffs),
    confirmations
  }
  if (confirmations > 0) value.height = 1_000
  return value
}

function chainAccount({ network, imported = false, address }) {
  const chainId = DASH_CHAIN_IDS[network]
  const coinType = network === 'mainnet' ? 5 : 1
  return {
    id: `chain-account-${network}-${imported ? 'imported' : 'hd'}`,
    scope: { keyDomainId: 'wallet-dash', accountId: 'account-dash', chainId },
    derivation: imported
      ? { scheme: 'imported', path: 'm' }
      : { scheme: 'bip44', path: `m/44'/${coinType}'/0'/0/0` },
    identity: { kind: 'account-identifier', value: address },
    createdAt: 1
  }
}

function storageFor(account) {
  const generationId = 'generation-dash'
  const sourceFingerprint = 'b'.repeat(64)
  return {
    async getActivePointer() {
      return { generationId, sourceFingerprint }
    },
    async getSnapshot(requested) {
      if (requested !== generationId) return null
      return {
        manifest: {
          status: 'verified',
          generationId,
          sourceFingerprint,
          activeAccount: {
            keyDomainId: account.scope.keyDomainId,
            accountId: account.scope.accountId
          }
        },
        keyDomains: [{ id: account.scope.keyDomainId, source: { kind: 'software' } }],
        accounts: [
          {
            id: account.scope.accountId,
            keyDomainId: account.scope.keyDomainId,
            accountIndex: 0
          }
        ],
        chainAccounts: [account]
      }
    }
  }
}

function createDiscovery(
  account,
  plans,
  { imported = false, fail = () => false, changeReservations } = {}
) {
  const calls = []
  const transactions = new Map()
  const rpc = {
    async assertExpectedChain() {
      if (fail()) throw new DashRpcError('network-unavailable', 'Dash Insight is unavailable')
    },
    async getAddressTransactions(address, page) {
      calls.push({ address, page })
      if (fail()) throw new DashRpcError('network-unavailable', 'Dash Insight is unavailable')
      const plan = plans.get(address)
      if (!plan) return parseDashAddressTransactions({ pagesTotal: 0, txs: [] })
      if (plan.failPages?.has(page)) {
        plan.failPages.delete(page)
        throw new DashRpcError('network-unavailable', 'Dash Insight page failed')
      }
      const pageBody = parseDashAddressTransactions({
        pagesTotal: plan.pages.length,
        txs: plan.pages[page] ?? []
      })
      for (const transaction of pageBody.transactions) transactions.set(transaction.transactionId, transaction)
      return pageBody
    },
    async getAddressUtxos(addresses) {
      calls.push({ kind: 'utxos', count: addresses.length })
      if (fail()) throw new DashRpcError('network-unavailable', 'Dash Insight is unavailable')
      const raw = addresses.flatMap(address => plans.get(address)?.utxos ?? [])
      return parseDashUtxos(raw, addresses)
    },
    async getTransaction(id) {
      if (fail()) throw new DashRpcError('network-unavailable', 'Dash Insight is unavailable')
      const found = transactions.get(id)
      if (found) return found
      return parseDashTransaction({
        ...insightTransaction({ id: 1, address: account.identity.value, script: '00' }),
        txid: id
      })
    }
  }
  let now = 10_000
  const repository = new MemoryDashDiscoveryRepository()
  const inputReservations = new MemoryDashInputReservationRepository()
  const scanner = new DashGapLimitScanner({
    derivation: {
      async deriveAddress(_keyDomainId, input) {
        if (imported && (input.change || input.addressIndex !== 0 || input.accountIndex !== 0)) {
          throw new Error('Imported Dash derivation was scanned past 0/false/0')
        }
        const located = p2pkh(input.chainId === DASH_CHAIN_IDS.mainnet ? 76 : 140, input.change ? 100 + input.addressIndex : input.addressIndex)
        calls.push({
          kind: 'derive',
          change: input.change,
          addressIndex: input.addressIndex,
          address: located.address
        })
        const coinType = input.chainId === DASH_CHAIN_IDS.mainnet ? 5 : 1
        return {
          chainId: input.chainId,
          network: input.chainId === DASH_CHAIN_IDS.mainnet ? 'mainnet' : 'testnet',
          accountIndex: input.accountIndex,
          change: input.change,
          addressIndex: input.addressIndex,
          address: located.address,
          addressScheme: 'dash_p2pkh',
          derivationScheme: imported ? 'imported' : 'bip44',
          derivationPath: imported
            ? 'm'
            : `m/44'/${coinType}'/${input.accountIndex}'/${input.change ? 1 : 0}/${input.addressIndex}`,
          publicKey: PUBLIC_KEY,
          masterFingerprint: '0xabcdef01',
          scriptPubKey: `0x${located.script}`
        }
      },
      async deriveAddresses(keyDomainId, input, signal) {
        const derived = []
        for (let offset = 0; offset < input.count; offset += 1) {
          derived.push(
            await this.deriveAddress(
              keyDomainId,
              {
                chainId: input.chainId,
                accountIndex: input.accountIndex,
                change: input.change,
                addressIndex: input.startAddressIndex + offset
              },
              signal
            )
          )
        }
        return derived
      }
    },
    rpc
  })
  const discovery = new DashDiscoveryCoordinator({
    storageRepository: storageFor(account),
    discoveryRepository: repository,
    scanner,
    changeReservations: { list: async () => changeReservations ?? [] },
    chainId: account.scope.chainId,
    minimumRefreshIntervalMs: 0,
    now: () => {
      now += 1
      return now
    }
  })
  const portfolio = new DashPortfolioCoordinator({
    storageRepository: storageFor(account),
    discovery,
    inputReservations,
    chainId: account.scope.chainId,
    chains,
    assets
  })
  return { calls, discovery, portfolio, repository, inputReservations, plans }
}

function receiveAddress(index) {
  return p2pkh(140, index)
}

function historyAddresses(calls) {
  return new Set(calls.filter(call => Number.isInteger(call.page)).map(call => call.address))
}

function derivedIndexes(calls, change, { withHistory }) {
  const history = historyAddresses(calls)
  return calls
    .filter(
      call =>
        call.kind === 'derive' &&
        call.change === change &&
        history.has(call.address) === withHistory
    )
    .map(call => call.addressIndex)
}

test('stops a P2PKH scan after 20 unused addresses and resumes an interrupted history page', async () => {
  expect(DASH_GAP_LIMIT).toBe(20)
  const first = receiveAddress(0)
  const account = chainAccount({ network: 'testnet', address: first.address })
  const plans = new Map([
    [
      first.address,
      {
        pages: [
          [insightTransaction({ id: 1, address: first.address, script: first.script })],
          [insightTransaction({ id: 2, address: first.address, script: first.script })],
          [insightTransaction({ id: 3, address: first.address, script: first.script })]
        ],
        failPages: new Set([1]),
        utxos: [utxo(first.address, 1, first.script, 100_000_000n, 6)]
      }
    ]
  ])
  const harness = createDiscovery(account, plans)
  await expect(harness.discovery.scanActive()).rejects.toBeInstanceOf(DashDiscoveryError)

  const resumed = await harness.discovery.scanActive()
  const history = harness.calls
    .filter(call => call.address === first.address && Number.isInteger(call.page))
    .map(call => call.page)
  expect(history).toEqual([0, 1, 1, 2])
  expect(history.filter(page => page === 0)).toEqual([0])

  const receiveIndexes = harness.calls
    .filter(call => call.kind === 'derive' && call.change === false)
    .map(call => call.addressIndex)
  expect([...new Set(derivedIndexes(harness.calls, false, { withHistory: true }))]).toEqual([
    ...Array(21).keys()
  ])
  expect(receiveIndexes.filter(index => index === 0)).toEqual([0, 0])
  expect(derivedIndexes(harness.calls, false, { withHistory: false })).toEqual(
    [...Array(DASH_LOOKAHEAD_ADDRESSES).keys()].map(index => index + 21)
  )
  expect(derivedIndexes(harness.calls, true, { withHistory: true })).toEqual([
    ...Array(DASH_GAP_LIMIT).keys()
  ])
  expect(derivedIndexes(harness.calls, true, { withHistory: false })).toEqual(
    [...Array(DASH_LOOKAHEAD_ADDRESSES).keys()].map(index => index + DASH_GAP_LIMIT)
  )
  expect(dashCurrentReceiveAddress(resumed)).toBe(receiveAddress(1).address)
  expect(resumed.observations.find(item => item.derived.address === receiveAddress(1).address)?.derived.privacy).toBe(
    'transparent'
  )

  const mainnet = chainAccount({
    network: 'mainnet',
    address: p2pkh(76, 0).address
  })
  expect(await harness.repository.get({ chainAccount: mainnet, accountIndex: 0 })).toBeNull()
})

test('keeps unconfirmed, immature coinbase, and DIP2 outputs out of the spendable set', async () => {
  const located = receiveAddress(0)
  const account = chainAccount({ network: 'testnet', address: located.address })
  const plans = new Map([
    [
      located.address,
      {
        pages: [[
          insightTransaction({ id: 10, address: located.address, script: located.script, confirmations: 0, duffs: 10_000_000n }),
          insightTransaction({
            id: 11,
            address: located.address,
            script: located.script,
            confirmations: DASH_COINBASE_MATURITY - 1,
            duffs: 20_000_000n,
            coinbase: true
          }),
          insightTransaction({
            id: 12,
            address: located.address,
            script: located.script,
            confirmations: DASH_COINBASE_MATURITY,
            duffs: 30_000_000n,
            coinbase: true
          }),
          insightTransaction({
            id: 13,
            address: located.address,
            script: located.script,
            confirmations: 8,
            duffs: 40_000_000n,
            type: 5
          })
        ]],
        utxos: [
          utxo(located.address, 10, located.script, 10_000_000n, 0),
          utxo(located.address, 11, located.script, 20_000_000n, DASH_COINBASE_MATURITY - 1),
          utxo(located.address, 12, located.script, 30_000_000n, DASH_COINBASE_MATURITY),
          utxo(located.address, 13, located.script, 40_000_000n, 8)
        ]
      }
    ]
  ])
  const harness = createDiscovery(account, plans)
  const source = await harness.portfolio.refreshActiveSource()
  const state = await harness.repository.get({ chainAccount: account, accountIndex: 0 })
  const spendable = collectDashSpendableUtxos(state.observations)
  expect(spendable.map(utxo => utxo.transactionId)).toEqual([txid(12)])
  const held = state.observations.flatMap(observation => observation.utxos).filter(item => item.kind === 'held')
  expect(held.map(item => item.reason).sort()).toEqual([
    'coinbase-immature',
    'dip2-special-transaction',
    'unconfirmed'
  ])
  const special = held.find(item => item.reason === 'dip2-special-transaction')
  expect(Object.hasOwn(special, 'scriptHex')).toBe(false)
  expect(source.source.balances[0]).toMatchObject({
    totalRaw: '100000000',
    spendableRaw: '30000000',
    availableRaw: '30000000',
    pendingRaw: '10000000'
  })

  await harness.inputReservations.reserve({
    chainAccount: account,
    accountIndex: 0,
    network: 'testnet',
    imported: false,
    transactionId: txid(80),
    outpoints: [{ transactionId: txid(12), outputIndex: 0 }],
    now: 20_000
  })
  const reserved = await harness.portfolio.readCachedActiveSource()
  expect(reserved.source.balances[0].availableRaw).toBe('0')
  expect(reserved.source.balances[0].totalRaw).toBe('100000000')
  expect(reserved.source.balances[0].spendableRaw).toBe('30000000')
})

test('keeps a discovered balance stale when Insight fails', async () => {
  const located = receiveAddress(0)
  const account = chainAccount({ network: 'testnet', address: located.address })
  const plans = new Map([
    [
      located.address,
      {
        pages: [[insightTransaction({ id: 21, address: located.address, script: located.script, duffs: 50_000_000n })]],
        utxos: [utxo(located.address, 21, located.script, 50_000_000n, 6)]
      }
    ]
  ])
  let insightDown = false
  const harness = createDiscovery(account, plans, { fail: () => insightDown })
  const fresh = await harness.portfolio.refreshActiveSource()
  expect(fresh.source.status).toBe('ready')
  expect(fresh.source.balances[0].totalRaw).toBe('50000000')

  insightDown = true
  const stale = await harness.portfolio.refreshActiveSource()
  expect(stale.source.status).toBe('error')
  expect(stale.source.errorCode).toBe('network-unavailable')
  expect(stale.source.balances[0].totalRaw).toBe('50000000')
  expect(stale.source.balances[0].availableRaw).toBe('50000000')
  const model = buildPortfolioReadModel(
    { keyDomainId: account.scope.keyDomainId, accountId: account.scope.accountId },
    [stale.source],
    chains,
    assets
  )
  const dash = model.chains.find(chain => chain.chain.family === 'dash')
  expect(dash.assets[0].freshness).toBe('stale')
  expect(dash.assets[0].balance.totalRaw).toBe('50000000')

  const empty = createDiscovery(
    chainAccount({ network: 'testnet', address: receiveAddress(4).address }),
    new Map(),
    { fail: () => true }
  )
  const missing = await empty.portfolio.refreshActiveSource()
  expect(missing.source.status).toBe('error')
  expect(missing.source.balances).toEqual([
    expect.objectContaining({
      totalRaw: '0',
      spendableRaw: '0',
      availableRaw: '0',
      pendingRaw: '0',
      updatedAt: 0
    })
  ])
  expect(await empty.repository.get({ chainAccount: emptyAccount(empty), accountIndex: 0 })).toBeNull()
})

function emptyAccount() {
  return chainAccount({ network: 'testnet', address: receiveAddress(4).address })
}

test('does not scan past the imported key coordinate', async () => {
  const located = receiveAddress(0)
  const account = chainAccount({ network: 'testnet', imported: true, address: located.address })
  const plans = new Map([
    [
      located.address,
      {
        pages: [[insightTransaction({ id: 30, address: located.address, script: located.script })]],
        utxos: [utxo(located.address, 30, located.script, 100_000_000n, 6)]
      }
    ]
  ])
  const harness = createDiscovery(account, plans, { imported: true })
  const source = await harness.portfolio.refreshActiveSource()
  const derived = harness.calls.filter(call => call.kind === 'derive')
  expect(derived).toEqual([
    {
      kind: 'derive',
      change: false,
      addressIndex: 0,
      address: located.address
    }
  ])
  expect(source.source.balances[0].availableRaw).toBe('100000000')
  expect(dashCurrentReceiveAddress(await harness.repository.get({ chainAccount: account, accountIndex: 0 }))).toBe(
    located.address
  )
})

test('includes a reserved change output that was allocated beyond the completed gap', async () => {
  const receive = receiveAddress(0)
  const account = chainAccount({ network: 'testnet', address: receive.address })
  const change = p2pkh(140, 100 + DASH_GAP_LIMIT)
  const plans = new Map()
  const reservations = []
  const harness = createDiscovery(account, plans, { changeReservations: reservations })
  const initial = await harness.portfolio.refreshActiveSource()
  expect(initial.source.balances[0].totalRaw).toBe('0')
  expect(derivedIndexes(harness.calls, true, { withHistory: true })).not.toContain(DASH_GAP_LIMIT)

  reservations.push({ state: 'committed', addressIndex: DASH_GAP_LIMIT })
  plans.set(change.address, {
    pages: [[
      insightTransaction({
        id: 50,
        address: change.address,
        script: change.script,
        duffs: 3_080_582n,
        confirmations: 1
      })
    ]],
    utxos: [utxo(change.address, 50, change.script, 3_080_582n, 1)]
  })
  const recovered = await harness.portfolio.refreshActiveSource()
  expect(recovered.source.balances[0]).toMatchObject({
    totalRaw: '3080582',
    spendableRaw: '3080582',
    availableRaw: '3080582'
  })
  const state = await harness.repository.get({ chainAccount: account, accountIndex: 0 })
  expect(collectDashSpendableUtxos(state.observations).map(item => item.valueDuffs)).toEqual(['3080582'])
  expect(derivedIndexes(harness.calls, true, { withHistory: true })).toContain(DASH_GAP_LIMIT)
})

test('finds a change output beyond the completed gap without a local reservation', async () => {
  const receive = receiveAddress(0)
  const account = chainAccount({ network: 'testnet', address: receive.address })
  const change = p2pkh(140, 100 + DASH_GAP_LIMIT)
  const plans = new Map()
  const harness = createDiscovery(account, plans, { changeReservations: [] })
  const initial = await harness.portfolio.refreshActiveSource()
  expect(initial.source.balances[0].totalRaw).toBe('0')
  expect(derivedIndexes(harness.calls, true, { withHistory: true })).not.toContain(DASH_GAP_LIMIT)

  plans.set(change.address, {
    pages: [[
      insightTransaction({
        id: 51,
        address: change.address,
        script: change.script,
        duffs: 3_080_582n,
        confirmations: 1660
      })
    ]],
    utxos: [utxo(change.address, 51, change.script, 3_080_582n, 1660)]
  })
  const recovered = await harness.portfolio.refreshActiveSource()
  expect(recovered.source.balances[0]).toMatchObject({
    totalRaw: '3080582',
    spendableRaw: '3080582',
    availableRaw: '3080582'
  })
  const state = await harness.repository.get({ chainAccount: account, accountIndex: 0 })
  expect(
    state.observations.find(item => item.derived.address === change.address)?.derived.addressIndex
  ).toBe(DASH_GAP_LIMIT)
  expect(harness.calls.some(call => call.kind === 'utxos' && call.count > 1)).toBe(true)
})

function derivedChange(addressIndex) {
  const located = p2pkh(140, 100 + addressIndex)
  return {
    chainId: DASH_CHAIN_IDS.testnet,
    network: 'testnet',
    accountIndex: 0,
    change: true,
    addressIndex,
    address: located.address,
    scheme: 'dash_p2pkh',
    purpose: 'change',
    privacy: 'transparent',
    derivationScheme: 'bip44',
    derivationPath: `m/44'/1'/0'/1/${addressIndex}`,
    publicKey: PUBLIC_KEY,
    scriptPubKey: `0x${located.script}`
  }
}

test('finds a reserved change output beyond the lookahead window in one refresh', async () => {
  const receive = receiveAddress(0)
  const account = chainAccount({ network: 'testnet', address: receive.address })
  const addressIndex = DASH_GAP_LIMIT + DASH_LOOKAHEAD_ADDRESSES
  const change = derivedChange(addressIndex)
  const plans = new Map()
  const reservations = []
  const harness = createDiscovery(account, plans, { changeReservations: reservations })
  const initial = await harness.portfolio.refreshActiveSource()
  expect(initial.source.balances[0].totalRaw).toBe('0')

  reservations.push({ state: 'committed', addressIndex, address: change })
  plans.set(change.address, {
    utxos: [utxo(change.address, 52, change.scriptPubKey.slice(2), 3_080_582n, 1)]
  })
  const historyBefore = harness.calls.filter(call => Number.isInteger(call.page)).length
  const recovered = await harness.portfolio.refreshActiveSource()
  const historyAfter = harness.calls.filter(call => Number.isInteger(call.page)).length
  expect(historyAfter - historyBefore).toBeLessThanOrEqual(DASH_GAP_LIMIT)
  expect(recovered.source.balances[0]).toMatchObject({
    totalRaw: '3080582',
    spendableRaw: '3080582',
    availableRaw: '3080582'
  })
})
