import * as secp256k1 from '@bitcoinerlab/secp256k1'
import { test } from 'node:test'
import { expect } from '@playwright/test'
import { initEccLib, networks, payments } from 'bitcoinjs-lib'

import { parseTransactionId } from '../../../../src/core/transactions/domain/index.ts'
import { BitcoinTransferPreparationCoordinator } from '../../../../src/infrastructure/chains/bitcoin/index.ts'
import { parsePreparedBitcoinPsbt } from '../../../../src/infrastructure/chains/bitcoin/bitcoin-prepared-psbt-validator.ts'

initEccLib(secp256k1)

const chainId = 'bip122:000000000019d6689c085ae165831e93'
const transactionId = parseTransactionId('transaction:bitcoin:preparation')

function keyMaterial(digit, change, addressIndex) {
  const privateKey = Buffer.alloc(32)
  privateKey[31] = digit
  const publicKey = Buffer.from(secp256k1.pointFromScalar(privateKey, true))
  const address = payments.p2wpkh({ pubkey: publicKey, network: networks.bitcoin }).address
  if (!address) throw new Error('Unable to derive Bitcoin test address')
  return {
    address,
    derived: {
      chainId,
      addressType: 'p2wpkh',
      accountIndex: 0,
      change,
      addressIndex,
      address,
      addressScheme: 'bitcoin-p2wpkh',
      derivationScheme: 'bip84',
      derivationPath: `m/84'/0'/0'/${change ? 1 : 0}/${addressIndex}`,
      publicKey: `0x${publicKey.toString('hex')}`
    }
  }
}

function context() {
  const sender = keyMaterial(1, false, 0)
  const unused = keyMaterial(2, false, 1)
  const discoveredChange = keyMaterial(3, true, 0)
  const recipient = keyMaterial(5, false, 0)
  const chainAccount = {
    id: 'chain-account:bitcoin:preparation',
    scope: {
      keyDomainId: 'key-domain:bitcoin:preparation',
      accountId: 'account:bitcoin:preparation',
      chainId
    },
    derivation: { scheme: 'bip84', path: "m/84'/0'/0'/0/0" },
    identity: { kind: 'account-identifier', value: sender.address },
    createdAt: 1_000
  }
  const observation = (derived, used, utxos = []) => ({
    derived,
    activity: {
      confirmedTransactionCount: used ? 1 : 0,
      mempoolTransactionCount: 0,
      used
    },
    utxos
  })
  const state = {
    chainAccount,
    accountIndex: 0,
    checkpoint: {
      schemaVersion: 1,
      chainId,
      accountIndex: 0,
      gapLimit: 1,
      maximumAddressesPerTarget: 20,
      cursors: [
        {
          target: { addressType: 'p2wpkh', change: false },
          nextAddressIndex: 2,
          consecutiveUnused: 1,
          complete: true
        },
        {
          target: { addressType: 'p2wpkh', change: true },
          nextAddressIndex: 1,
          consecutiveUnused: 1,
          complete: true
        }
      ]
    },
    observations: [
      observation(sender.derived, true, [
        {
          transactionId: 'a'.repeat(64),
          outputIndex: 0,
          valueRaw: '100000',
          status: {
            confirmed: true,
            blockHeight: 900,
            blockHash: 'b'.repeat(64),
            blockTime: 1_000
          }
        }
      ]),
      observation(unused.derived, false),
      observation(discoveredChange.derived, false)
    ],
    updatedAt: 2_000
  }
  return { sender, recipient, chainAccount, state }
}

function harness(options = {}) {
  const current = context()
  const calls = []
  const inputReservations = {
    list: async () => options.inputReservations ?? [],
    reserve: async input => {
      calls.push(['reserve-inputs', input.outpoints])
      return {
        schemaVersion: 1,
        chainAccount: input.chainAccount,
        accountIndex: input.accountIndex,
        addressType: input.addressType,
        transactionId: input.transactionId,
        state: options.reserveState ?? 'reserved',
        outpoints: input.outpoints,
        createdAt: input.now,
        updatedAt: input.now
      }
    },
    release: async (_scope, requestedTransactionId) => {
      calls.push(['release-inputs', requestedTransactionId])
      if (options.releaseThrows) throw new Error('input cleanup failed')
    }
  }
  const coordinator = new BitcoinTransferPreparationCoordinator({
    discoveryRepository: {
      get: async () => options.discovery ?? current.state
    },
    derivation: {
      deriveAddress: async (keyDomainId, input) => {
        calls.push(['derive-signer', keyDomainId, input])
        return (
          options.derivedSigner ?? {
            ...current.sender.derived,
            masterFingerprint: '0x01020304'
          }
        )
      }
    },
    rpc: {
      assertExpectedChain: async () => calls.push(['assert-chain']),
      getTipHeight: async () => 1_000,
      getFeeEstimates: async () => {
        if (options.feeEstimatesThrow) throw new Error('fee estimates must not be requested')
        return { 6: 2 }
      }
    },
    inputReservations,
    ...(options.changeReservations ? { changeReservations: options.changeReservations } : {}),
    now: () => 3_000,
    selectChangeOutputPosition: () => options.changeOutputPosition ?? 'last'
  })
  return { ...current, calls, coordinator }
}

function prepareInput(testHarness, amount = { mode: 'exact', valueSats: '50000' }) {
  return {
    chainAccount: testHarness.chainAccount,
    accountIndex: 0,
    transactionId,
    addressType: 'p2wpkh',
    recipient: testHarness.recipient.address,
    amount
  }
}

test('prepares a fee-bound PSBT from the active address and returns change to it', async () => {
  const testHarness = harness()
  const plan = await testHarness.coordinator.prepare(prepareInput(testHarness))

  expect(plan).toMatchObject({
    transactionId,
    signerAddress: testHarness.sender.address,
    feeRate: { requestedTargetBlocks: 6, sourceTargetBlocks: 6, satsPerVbyte: 2 },
    selection: {
      selectedTotalSats: '100000',
      amountSats: '50000',
      feeSats: '284',
      changeSats: '49716'
    },
    inputReservation: { state: 'reserved', outpoints: [{ outputIndex: 0 }] },
    changeReservation: null,
    prepared: {
      lockTime: 1_000,
      rbf: true,
      recipientOutputIndex: 0,
      changeOutputIndex: 1,
      changeAddress: testHarness.sender.address
    },
    discoveryUpdatedAt: 2_000
  })
  expect(testHarness.calls.map(call => call[0])).toEqual([
    'derive-signer',
    'assert-chain',
    'reserve-inputs'
  ])
  expect(() => parsePreparedBitcoinPsbt(plan.prepared)).not.toThrow()
})

test('spends Ledger receive children together and reserves a change child on the device root', async () => {
  const baseline = context()
  const root = "m/84'/0'/5'"
  const second = keyMaterial(7, false, 1)
  const change = keyMaterial(8, true, 1)
  const withRoot = derived => ({
    ...derived,
    derivationPath: `${root}/${derived.change ? 1 : 0}/${derived.addressIndex}`
  })
  const discovery = {
    ...baseline.state,
    chainAccount: {
      ...baseline.chainAccount,
      derivation: { scheme: 'bip84', path: `${root}/0/0` }
    },
    checkpoint: {
      ...baseline.state.checkpoint,
      cursors: [
        { ...baseline.state.checkpoint.cursors[0], nextAddressIndex: 3 },
        baseline.state.checkpoint.cursors[1]
      ]
    },
    observations: [
      { ...baseline.state.observations[0], derived: withRoot(baseline.sender.derived) },
      {
        derived: withRoot(second.derived),
        activity: { confirmedTransactionCount: 1, mempoolTransactionCount: 0, used: true },
        utxos: [
          {
            transactionId: 'c'.repeat(64),
            outputIndex: 0,
            valueRaw: '100000',
            status: {
              confirmed: true,
              blockHeight: 900,
              blockHash: 'd'.repeat(64),
              blockTime: 1_000
            }
          }
        ]
      },
      {
        derived: withRoot(keyMaterial(9, false, 2).derived),
        activity: { confirmedTransactionCount: 0, mempoolTransactionCount: 0, used: false },
        utxos: []
      },
      {
        ...baseline.state.observations[2],
        derived: withRoot(baseline.state.observations[2].derived)
      }
    ]
  }
  const reservedChange = {
    schemaVersion: 1,
    chainAccount: discovery.chainAccount,
    accountIndex: 0,
    addressType: 'p2wpkh',
    transactionId,
    state: 'reserved',
    addressIndex: 1,
    address: { ...withRoot(change.derived), masterFingerprint: '0x01020304' },
    createdAt: 3_000,
    updatedAt: 3_000
  }
  const changeCalls = []
  const testHarness = harness({
    discovery,
    derivedSigner: { ...withRoot(baseline.sender.derived), masterFingerprint: '0x01020304' },
    changeReservations: {
      reserve: async input => {
        changeCalls.push(input)
        return reservedChange
      },
      abandon: async () => {
        throw new Error('Successful preparation must not abandon change')
      }
    }
  })
  const plan = await testHarness.coordinator.prepare({
    ...prepareInput(testHarness, { mode: 'exact', valueSats: '150000' }),
    chainAccount: discovery.chainAccount,
    ledgerAccount: true
  })
  expect(plan.selection.selectedUtxos.map(utxo => utxo.derivationPath)).toEqual([
    `${root}/0/0`,
    `${root}/0/1`
  ])
  expect(plan.changeReservation).toBe(reservedChange)
  expect(plan.prepared.changeAddress).toBe(change.address)
  expect(changeCalls).toHaveLength(1)
  expect(() => parsePreparedBitcoinPsbt(plan.prepared)).not.toThrow()
})

test('uses an explicit dApp fee rate without depending on fee estimates', async () => {
  const testHarness = harness({ feeEstimatesThrow: true })
  const plan = await testHarness.coordinator.prepare({
    ...prepareInput(testHarness),
    feeRateSatsPerVbyte: 7
  })

  expect(plan.feeRate).toEqual({
    requestedTargetBlocks: 6,
    sourceTargetBlocks: 6,
    satsPerVbyte: 7
  })
  expect(plan.selection.feeRateSatsPerVbyte).toBe(7)
})

test('prepares Max without allocating a change address', async () => {
  const testHarness = harness()
  const plan = await testHarness.coordinator.prepare(prepareInput(testHarness, { mode: 'max' }))

  expect(plan).toMatchObject({
    selection: { amountSats: '99778', feeSats: '222', changeSats: '0' },
    changeReservation: null,
    prepared: { outputCount: 1, changeAddress: null }
  })
  expect(testHarness.calls.map(call => call[0])).toEqual([
    'derive-signer',
    'assert-chain',
    'reserve-inputs'
  ])
})

test('excludes inputs reserved by another transaction before coin selection', async () => {
  const current = context()
  const testHarness = harness({
    inputReservations: [
      {
        schemaVersion: 1,
        chainAccount: current.chainAccount,
        accountIndex: 0,
        addressType: 'p2wpkh',
        transactionId: 'transaction:bitcoin:other',
        state: 'committed',
        outpoints: [{ transactionId: 'a'.repeat(64), outputIndex: 0 }],
        createdAt: 2_500,
        updatedAt: 2_500
      }
    ]
  })

  await expect(testHarness.coordinator.prepare(prepareInput(testHarness))).rejects.toMatchObject({
    code: 'insufficient-funds'
  })
  expect(testHarness.calls.map(call => call[0])).toEqual(['derive-signer', 'assert-chain'])

  const alreadyCommitted = harness({ reserveState: 'committed' })
  await expect(
    alreadyCommitted.coordinator.prepare(prepareInput(alreadyCommitted))
  ).rejects.toThrow(/input reservation is not ready/)
  expect(alreadyCommitted.calls.map(call => call[0])).toEqual([
    'derive-signer',
    'assert-chain',
    'reserve-inputs'
  ])
})

test('fails before network or reservation when discovery is incomplete or account identity differs', async () => {
  const current = context()
  const incomplete = structuredClone(current.state)
  incomplete.checkpoint.cursors[0].complete = false
  incomplete.checkpoint.cursors[0].consecutiveUnused = 0
  const testHarness = harness({ discovery: incomplete })

  await expect(testHarness.coordinator.prepare(prepareInput(testHarness))).rejects.toThrow(
    /discovery must complete/
  )
  expect(testHarness.calls).toEqual([])

  const mismatched = structuredClone(current.state)
  mismatched.chainAccount.identity.value = current.recipient.address
  const identityMismatch = harness({ discovery: mismatched })
  await expect(
    identityMismatch.coordinator.prepare(prepareInput(identityMismatch))
  ).rejects.toThrow(/does not match the selected ChainAccount/)
  expect(identityMismatch.calls).toEqual([])
})

test('releases inputs when self-change PSBT construction fails', async () => {
  const testHarness = harness({ changeOutputPosition: 'middle' })

  await expect(testHarness.coordinator.prepare(prepareInput(testHarness))).rejects.toThrow(
    /change output position/
  )
  expect(testHarness.calls.map(call => call[0])).toEqual([
    'derive-signer',
    'assert-chain',
    'reserve-inputs',
    'release-inputs'
  ])
})

test('does not hide failed input cleanup after preparation aborts', async () => {
  const testHarness = harness({ changeOutputPosition: 'middle', releaseThrows: true })

  await expect(testHarness.coordinator.prepare(prepareInput(testHarness))).rejects.toThrow(
    /cleanup failed/
  )
})

test('uses the WASM-derived master fingerprint and rejects caller injection', async () => {
  const testHarness = harness()
  await expect(
    testHarness.coordinator.prepare({
      ...prepareInput(testHarness),
      masterFingerprint: '0x01020304'
    })
  ).rejects.toThrow(/Invalid Bitcoin transfer preparation input/)
  expect(testHarness.calls).toEqual([])

  const current = context()
  const invalidFingerprint = harness({
    derivedSigner: { ...current.sender.derived, masterFingerprint: '0x0102030A' }
  })
  await expect(
    invalidFingerprint.coordinator.prepare(prepareInput(invalidFingerprint))
  ).rejects.toMatchObject({ code: 'invalid-intent' })
  expect(invalidFingerprint.calls.map(call => call[0])).toEqual(['derive-signer'])
})

test('rejects a WASM-derived signer that does not match the discovered account', async () => {
  const current = context()
  const testHarness = harness({
    derivedSigner: { ...current.recipient.derived, masterFingerprint: '0x01020304' }
  })

  await expect(testHarness.coordinator.prepare(prepareInput(testHarness))).rejects.toThrow(
    /WASM-derived Bitcoin signer does not match discovery/
  )
  expect(testHarness.calls.map(call => call[0])).toEqual(['derive-signer'])
})
