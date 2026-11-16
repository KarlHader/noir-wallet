import { test } from 'node:test'
import { expect } from '@playwright/test'

import { parseChainId } from '../../../../src/core/chains/registry/index.ts'
import { BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS } from '../../../../src/core/chains/bitcoin/index.ts'
import { parseKeyDomainId } from '../../../../src/core/keyring/domain/index.ts'
import {
  BitcoinDiscoveryError,
  BitcoinGapLimitScanner
} from '../../../../src/infrastructure/chains/bitcoin/bitcoin-gap-limit-scanner.ts'

const chainId = parseChainId('bip122:000000000019d6689c085ae165831e93').id
const keyDomainId = parseKeyDomainId('key-domain:bitcoin-scanner-test')

function targetKey(target) {
  return `${target.addressType}:${target.change ? 'change' : 'receive'}`
}

function derived(input) {
  const profile =
    input.addressType === 'p2pkh'
      ? { purpose: 44, scheme: 'bip44', addressScheme: 'bitcoin-p2pkh' }
      : input.addressType === 'p2sh-p2wpkh'
        ? { purpose: 49, scheme: 'bip49', addressScheme: 'bitcoin-p2sh-p2wpkh' }
        : input.addressType === 'p2wpkh'
          ? { purpose: 84, scheme: 'bip84', addressScheme: 'bitcoin-p2wpkh' }
          : { purpose: 86, scheme: 'bip86', addressScheme: 'bitcoin-p2tr' }
  return Object.freeze({
    ...input,
    address: `${targetKey(input)}:${input.addressIndex}`,
    addressScheme: profile.addressScheme,
    derivationScheme: profile.scheme,
    derivationPath: `m/${profile.purpose}'/0'/${input.accountIndex}'/${input.change ? 1 : 0}/${input.addressIndex}`,
    publicKey: `0x02${'1'.repeat(64)}`
  })
}

function scannerHarness({ used = new Set(), failAddress, utxos = new Map() } = {}) {
  const calls = []
  let failed = false
  const scanner = new BitcoinGapLimitScanner({
    derivation: {
      deriveAddress: async (requestedKeyDomainId, input) => {
        calls.push(['derive', requestedKeyDomainId, input])
        return derived(input)
      },
      deriveAddresses: async (requestedKeyDomainId, input) => {
        calls.push(['derive-batch', requestedKeyDomainId, input])
        return Array.from({ length: input.count }, (_, offset) =>
          derived({ ...input, addressIndex: input.startAddressIndex + offset })
        )
      }
    },
    rpc: {
      assertExpectedChain: async () => {
        calls.push(['attest'])
      },
      getTipHeight: async () => 900000,
      getAddressActivity: async address => {
        calls.push(['activity', address])
        if (!failed && address === failAddress) {
          failed = true
          throw new Error('temporary RPC failure')
        }
        const isUsed = used.has(address)
        return {
          confirmedTransactionCount: isUsed ? 1 : 0,
          mempoolTransactionCount: 0,
          used: isUsed
        }
      },
      getAddressUtxos: async address => {
        calls.push(['utxos', address])
        return utxos.get(address) ?? []
      }
    }
  })
  return { scanner, calls }
}

function baseInput(overrides = {}) {
  return {
    keyDomainId,
    chainId,
    accountIndex: 0,
    targets: [{ addressType: 'p2wpkh', change: false }],
    gapLimit: 3,
    maximumAddressesPerTarget: 10,
    ...overrides
  }
}

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}

test('scans sequentially until the configured unused gap and fetches UTXOs only for used addresses', async () => {
  const used = new Set(['p2wpkh:receive:0', 'p2wpkh:receive:2'])
  const utxo = Object.freeze({
    transactionId: 'a'.repeat(64),
    outputIndex: 0,
    valueRaw: '1000',
    status: Object.freeze({ confirmed: false })
  })
  const harness = scannerHarness({
    used,
    utxos: new Map([
      ['p2wpkh:receive:0', [utxo]],
      ['p2wpkh:receive:2', [utxo]]
    ])
  })
  const progress = []

  const result = await harness.scanner.scan(
    baseInput({
      onProgress: async (observation, checkpoint) => {
        progress.push([observation.derived.address, checkpoint])
      }
    })
  )

  expect(result.observations.map(item => item.derived.address)).toEqual([
    'p2wpkh:receive:0',
    'p2wpkh:receive:1',
    'p2wpkh:receive:2',
    'p2wpkh:receive:3',
    'p2wpkh:receive:4',
    'p2wpkh:receive:5'
  ])
  expect(result.observations.filter(item => item.activity.used)).toHaveLength(2)
  expect(result.observations[0].utxos).toEqual([utxo])
  expect(result.observations[1].utxos).toEqual([])
  expect(result.checkpoint.cursors).toEqual([
    {
      target: { addressType: 'p2wpkh', change: false },
      nextAddressIndex: 6,
      consecutiveUnused: 3,
      complete: true
    }
  ])
  expect(progress).toHaveLength(6)
  expect(harness.calls.filter(call => call[0] === 'utxos')).toEqual([
    ['utxos', 'p2wpkh:receive:0'],
    ['utxos', 'p2wpkh:receive:2']
  ])
  expect(harness.calls.filter(call => call[0] === 'derive-batch')).toHaveLength(2)
  expect(harness.calls[0]).toEqual(['attest'])
})

test('covers BIP-44, BIP-49, BIP-84 and BIP-86 receive/change targets', async () => {
  const harness = scannerHarness()
  const result = await harness.scanner.scan(
    baseInput({
      targets: BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS,
      gapLimit: 2,
      maximumAddressesPerTarget: 4
    })
  )

  expect(result.observations.map(item => item.derived.address)).toEqual([
    'p2wpkh:receive:0',
    'p2wpkh:receive:1',
    'p2wpkh:change:0',
    'p2wpkh:change:1',
    'p2tr:receive:0',
    'p2tr:receive:1',
    'p2tr:change:0',
    'p2tr:change:1',
    'p2pkh:receive:0',
    'p2pkh:receive:1',
    'p2pkh:change:0',
    'p2pkh:change:1',
    'p2sh-p2wpkh:receive:0',
    'p2sh-p2wpkh:receive:1',
    'p2sh-p2wpkh:change:0',
    'p2sh-p2wpkh:change:1'
  ])
  expect(result.checkpoint.cursors.every(cursor => cursor.complete)).toBe(true)
})

test('scans only the requested address type while preserving all target checkpoints', async () => {
  const harness = scannerHarness()
  const result = await harness.scanner.scan(
    baseInput({
      targets: BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS,
      addressType: 'p2tr',
      gapLimit: 2,
      maximumAddressesPerTarget: 4
    })
  )

  expect(result.observations.map(item => item.derived.address)).toEqual([
    'p2tr:receive:0',
    'p2tr:receive:1',
    'p2tr:change:0',
    'p2tr:change:1'
  ])
  expect(harness.calls.filter(call => call[0] === 'activity')).toHaveLength(4)
  expect(
    result.checkpoint.cursors.map(cursor => ({
      target: cursor.target,
      complete: cursor.complete
    }))
  ).toEqual(
    BITCOIN_FIRST_SLICE_DISCOVERY_TARGETS.map(target => ({
      target,
      complete: target.addressType === 'p2tr'
    }))
  )
})

test('stops an imported private-key target after its one fixed address even when it is used', async () => {
  const harness = scannerHarness({ used: new Set(['p2wpkh:receive:0']) })
  const result = await harness.scanner.scan(
    baseInput({
      gapLimit: 1,
      maximumAddressesPerTarget: 1,
      fixedAddressCountPerTarget: 1
    })
  )

  expect(result.observations).toHaveLength(1)
  expect(result.observations[0].activity.used).toBe(true)
  expect(result.checkpoint.cursors[0]).toEqual({
    target: { addressType: 'p2wpkh', change: false },
    nextAddressIndex: 1,
    consecutiveUnused: 0,
    complete: true
  })
})

test('resumes from the last persisted checkpoint after an RPC failure', async () => {
  const first = scannerHarness({ failAddress: 'p2wpkh:receive:1' })
  let persistedCheckpoint
  const error = await captureError(
    first.scanner.scan(
      baseInput({
        onProgress: async (_observation, checkpoint) => {
          persistedCheckpoint = checkpoint
        }
      })
    )
  )
  expect(error).toBeInstanceOf(BitcoinDiscoveryError)
  expect(error).toMatchObject({ code: 'rpc-failure' })
  expect(error.checkpoint).toBe(persistedCheckpoint)
  expect(error.checkpoint.cursors[0]).toMatchObject({
    nextAddressIndex: 1,
    consecutiveUnused: 1,
    complete: false
  })

  const resumed = scannerHarness()
  const result = await resumed.scanner.scan(baseInput({ checkpoint: persistedCheckpoint }))
  expect(result.observations.map(item => item.derived.address)).toEqual([
    'p2wpkh:receive:1',
    'p2wpkh:receive:2'
  ])
  expect(result.checkpoint.cursors[0]).toMatchObject({
    nextAddressIndex: 3,
    consecutiveUnused: 3,
    complete: true
  })
})

test('resumes a refreshed target without discarding later completed target progress', async () => {
  const harness = scannerHarness()
  const result = await harness.scanner.scan(
    baseInput({
      targets: [
        { addressType: 'p2wpkh', change: false },
        { addressType: 'p2wpkh', change: true }
      ],
      checkpoint: {
        schemaVersion: 1,
        chainId,
        accountIndex: 0,
        gapLimit: 3,
        maximumAddressesPerTarget: 10,
        cursors: [
          {
            target: { addressType: 'p2wpkh', change: false },
            nextAddressIndex: 3,
            consecutiveUnused: 1,
            complete: false
          },
          {
            target: { addressType: 'p2wpkh', change: true },
            nextAddressIndex: 3,
            consecutiveUnused: 3,
            complete: true
          }
        ]
      }
    })
  )

  expect(result.observations.map(item => item.derived.address)).toEqual([
    'p2wpkh:receive:3',
    'p2wpkh:receive:4'
  ])
  expect(result.checkpoint.cursors).toEqual([
    {
      target: { addressType: 'p2wpkh', change: false },
      nextAddressIndex: 5,
      consecutiveUnused: 3,
      complete: true
    },
    {
      target: { addressType: 'p2wpkh', change: true },
      nextAddressIndex: 3,
      consecutiveUnused: 3,
      complete: true
    }
  ])
  expect(harness.calls.filter(call => call[0] === 'derive-batch')).toHaveLength(1)
})

test('does not advance the recoverable checkpoint when progress persistence fails', async () => {
  const harness = scannerHarness()
  const error = await captureError(
    harness.scanner.scan(
      baseInput({
        onProgress: async () => {
          throw new Error('database unavailable')
        }
      })
    )
  )

  expect(error).toBeInstanceOf(BitcoinDiscoveryError)
  expect(error).toMatchObject({ code: 'progress-persistence-failure' })
  expect(error.checkpoint.cursors[0]).toMatchObject({
    nextAddressIndex: 0,
    consecutiveUnused: 0,
    complete: false
  })
})

test('accepts independently advanced targets but fails for mismatched checkpoints and scan limits', async () => {
  const harness = scannerHarness()
  const complete = await harness.scanner.scan(baseInput())
  const checkpointError = await captureError(
    harness.scanner.scan(
      baseInput({
        checkpoint: { ...complete.checkpoint, accountIndex: 1 }
      })
    )
  )
  expect(checkpointError).toBeInstanceOf(BitcoinDiscoveryError)
  expect(checkpointError).toMatchObject({ code: 'checkpoint-failure' })

  await expect(
    harness.scanner.scan(
      baseInput({
        targets: [
          { addressType: 'p2wpkh', change: false },
          { addressType: 'p2wpkh', change: true }
        ],
        checkpoint: {
          schemaVersion: 1,
          chainId,
          accountIndex: 0,
          gapLimit: 3,
          maximumAddressesPerTarget: 10,
          cursors: [
            {
              target: { addressType: 'p2wpkh', change: false },
              nextAddressIndex: 0,
              consecutiveUnused: 0,
              complete: false
            },
            {
              target: { addressType: 'p2wpkh', change: true },
              nextAddressIndex: 1,
              consecutiveUnused: 1,
              complete: false
            }
          ]
        }
      })
    )
  ).resolves.toMatchObject({ checkpoint: { cursors: [{ complete: true }, { complete: true }] } })

  const limited = scannerHarness({ used: new Set(['p2wpkh:receive:0']) })
  const limitError = await captureError(
    limited.scanner.scan(baseInput({ maximumAddressesPerTarget: 3 }))
  )
  expect(limitError).toBeInstanceOf(BitcoinDiscoveryError)
  expect(limitError).toMatchObject({ code: 'scan-limit-exceeded' })
  expect(limitError.checkpoint.cursors[0]).toMatchObject({
    nextAddressIndex: 3,
    consecutiveUnused: 2,
    complete: false
  })
})

test('returns a recoverable cancellation without deriving an address', async () => {
  const harness = scannerHarness()
  const controller = new AbortController()
  controller.abort()
  const error = await captureError(harness.scanner.scan(baseInput({ signal: controller.signal })))

  expect(error).toBeInstanceOf(BitcoinDiscoveryError)
  expect(error).toMatchObject({ code: 'cancelled' })
  expect(harness.calls).toEqual([['attest']])
})
