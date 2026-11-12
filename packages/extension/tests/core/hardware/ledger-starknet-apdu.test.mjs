import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  createLedgerMultichainHardwareCredential,
  parseStoredHardwareCredential
} from '../../../src/core/wallet/hardware-wallet-data.ts'
import { validateLedgerStarknetDerivationPath } from '../../../src/core/wallet/ledger-derivation-path.ts'
import { parseChainId } from '../../../src/core/chains/registry/index.ts'
import { parseSigningSummary } from '../../../src/core/keyring/domain/index.ts'
import { STARKNET_TRANSFER_SELECTOR } from '../../../src/infrastructure/chains/starknet/starknet-primitives.ts'
import {
  normalizeLedgerStarknetCalls,
  readLedgerStarknetTransactionNonce
} from '../../../src/lib/ledger/starknet-calls.ts'
import {
  encodeStarknetFeeWords,
  ledgerStarknetPathBytes,
  parseStarknetLedgerSignature,
  planStarknetGetVersionApdu,
  planStarknetInvokeApdus,
  readLedgerStarknetPublicKey,
  readLedgerStarknetVersion,
  starknetFeltBytes,
  starknetLedgerPublicKey,
  starknetStatusError,
  exchangeStarknetApdus
} from '../../../src/lib/ledger/starknet-model.ts'

const PATH = "m/2645'/1195502025'/1148870696'/0'/0'/0"
const HASH = '0x47925e9fbb257d423cff737a67c87d38c652eba94ab17d6647d27b8df4f48ff'

function fees() {
  return {
    tip: 1n,
    l1Gas: { maxAmount: 2n, maxPricePerUnit: 3n },
    l2Gas: { maxAmount: 4n, maxPricePerUnit: 5n },
    l1DataGas: { maxAmount: 0n, maxPricePerUnit: 0n }
  }
}

it('encodes the Argent path, version APDU, four fee words, and seven-felt chunks', () => {
  assert.equal(validateLedgerStarknetDerivationPath(PATH), PATH)
  assert.throws(() => validateLedgerStarknetDerivationPath("m/44'/9004'/0'/0/0"), /Starknet/)
  assert.throws(
    () => validateLedgerStarknetDerivationPath("m/2645'/1195502025'/1148870696'/0'/0'/0'"),
    /Starknet/
  )
  const path = ledgerStarknetPathBytes(PATH)
  assert.deepEqual(
    [...path.subarray(0, 12)],
    [0x80, 0x00, 0x0a, 0x55, 0xc7, 0x41, 0xe9, 0xc9, 0xc4, 0x7a, 0x60, 0x28]
  )
  assert.deepEqual(
    [...path.subarray(12)],
    [0x80, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
  )
  const version = planStarknetGetVersionApdu()
  assert.equal(version.cla, 0x5a)
  assert.equal(version.ins, 0x00)
  assert.equal(version.p1, 0)
  assert.equal(version.p2, 0)
  const words = encodeStarknetFeeWords(fees())
  assert.equal(words.length, 128)
  assert.equal(words[31], 1)
  assert.equal([...words.subarray(32, 40)].join(','), [0, 0, ...Buffer.from('L1_GAS')].join(','))
  assert.equal([...words.subarray(64, 72)].join(','), [0, 0, ...Buffer.from('L2_GAS')].join(','))
  assert.equal([...words.subarray(96, 104)].join(','), [0, ...Buffer.from('L1_DATA')].join(','))
  assert.equal(words[127], 0)
  const calldata = Array.from({ length: 8 }, (_, index) => `0x${index + 1}`)
  const apdus = planStarknetInvokeApdus({
    path: PATH,
    senderAddress: '0x1',
    chainIdFelt: '0x534e5f4d41494e',
    nonce: '0x2',
    dataAvailabilityMode: '0x0',
    fees: fees(),
    calls: [{ to: '0x3', selector: '0x4', calldata }]
  })
  const chunks = apdus.filter(apdu => apdu.ins === 0x03 && apdu.p1 === 6)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].p2, 0)
  assert.equal(chunks[0].data.length, 7 * 32)
  assert.equal(chunks[1].p2, 1)
  assert.equal(chunks[1].data.length, 4 * 32)
  const fee = apdus.find(apdu => apdu.p1 === 2)
  assert.equal(fee.data.length, 128)
})

it('parses the 65-byte key and drops V from R||S||V', () => {
  const key = new Uint8Array(65)
  key[0] = 0x04
  key[2] = 0x7f
  assert.equal(starknetLedgerPublicKey(key), '0x7f' + '00'.repeat(30))
  const hash = starknetFeltBytes(HASH)
  const frame = new Uint8Array(32 + 1 + 32 + 32 + 1)
  frame.set(hash, 0)
  frame[32] = 0x41
  frame[33] = 0x11
  frame[65] = 0x22
  frame[97] = 0x33
  const signature = parseStarknetLedgerSignature(frame, hash)
  assert.deepEqual(signature, { r: '0x11' + '00'.repeat(31), s: '0x22' + '00'.repeat(31) })
  assert.equal(frame[97], 0x33)
})

it('maps rejection and the wrong app through a mocked sendApdu', async () => {
  const seen = []
  await assert.rejects(
    exchangeStarknetApdus([planStarknetGetVersionApdu()], async apdu => {
      seen.push(apdu)
      return { data: new Uint8Array(), status: 0x6985 }
    }),
    /rejected/
  )
  assert.equal(seen[0].p1, 0)
  assert.equal(seen[0].p2, 0)
  assert.equal(
    starknetStatusError(0x6e00).message,
    'Ledger Starknet app rejected the request (0x6e00)'
  )
  await assert.rejects(
    readLedgerStarknetVersion(async () => ({ data: new Uint8Array([2, 4, 2]), status: 0x9000 })),
    /2\.4\.3/
  )
  const version = await readLedgerStarknetVersion(async apdu => {
    assert.equal(apdu.ins, 0)
    assert.equal(apdu.p1, 0)
    assert.equal(apdu.p2, 0)
    return { data: new Uint8Array([2, 4, 3]), status: 0x9000 }
  })
  assert.equal(version, '2.4.3')
  const publicKey = await readLedgerStarknetPublicKey(PATH, false, async apdu => {
    assert.equal(apdu.data.length, 24)
    const key = new Uint8Array(65)
    key[1] = 0x02
    return { data: key, status: 0x9000 }
  })
  assert.equal(publicKey, '0x2' + '00'.repeat(31))
})

it('keeps a schema 3 credential without a Starknet account and accepts the new variant', () => {
  const starknet = {
    family: 'starknet',
    accountIndex: 0,
    derivationPath: PATH,
    network: 'mainnet',
    publicKey: '0x2',
    address: '0x6a62e3abc08f1190cf071afeec31d1693f71c9f126e820b98d7017f133e6a27',
    classHash: '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f',
    accountType: 'argent',
    appVersion: '2.4.3'
  }
  const credential = createLedgerMultichainHardwareCredential({
    deviceModel: 'nanoX',
    deviceName: 'Ledger Test',
    accounts: [starknet]
  })
  assert.equal(credential.schemaVersion, 3)
  assert.deepEqual(parseStoredHardwareCredential(credential).capabilities, ['starknet'])
  assert.throws(
    () =>
      createLedgerMultichainHardwareCredential({
        deviceModel: 'nanoX',
        deviceName: 'Ledger Test',
        accounts: [{ ...starknet, derivationPath: "m/44'/60'/0'/0/0" }]
      }),
    /derivation path/
  )
})

it('sends four fee words for an invoke, including a zero L1 data word', () => {
  const apdus = planStarknetInvokeApdus({
    path: PATH,
    senderAddress: '0x1',
    chainIdFelt: '0x534e5f4d41494e',
    nonce: '0x1',
    dataAvailabilityMode: '0x0',
    fees: fees(),
    calls: [{ to: '0x3', selector: '0x4', calldata: ['0x5', '0x6', '0x0'] }]
  })
  const fee = apdus.find(apdu => apdu.p1 === 2)
  assert.equal(fee.data.length, 128)
  assert.equal(apdus[0].ins, 0x03)
  assert.equal([...fee.data.subarray(96, 104)].join(','), [0, ...Buffer.from('L1_DATA')].join(','))
})

const CLASS_HASH = '0x036078334509b514626504edc9fb252328d1a240e4e948bef8d0c08dff45927f'
const PUBLIC_KEY = '0x7f0ecd1ec6159e6a7c70084aaa7d693d9113149b80ab72618602a185e2c1f2b'
const SENDER = '0x6a62e3abc08f1190cf071afeec31d1693f71c9f126e820b98d7017f133e6a27'
const CHAIN_ID = parseChainId('starknet:SN_SEPOLIA').id

function bounds() {
  return {
    l1Gas: { maxAmount: '1', maxPricePerUnit: '1' },
    l2Gas: { maxAmount: '1', maxPricePerUnit: '1' },
    l1DataGas: { maxAmount: '0', maxPricePerUnit: '0' }
  }
}

it('reads a deploy nonce as a felt and rejects a decimal zero', () => {
  assert.equal(readLedgerStarknetTransactionNonce({ nonce: '0x0' }), '0x0')
  assert.throws(() => readLedgerStarknetTransactionNonce({ nonce: '0' }), /nonce must be a Starknet felt/)
  const nonce = readLedgerStarknetTransactionNonce({ nonce: '0x0' })
  const parsed = parseSigningSummary(
    {
      schema: 'starknet.deploy-account.v1',
      chainId: CHAIN_ID,
      operation: 'transaction',
      review: { level: 'caution', issues: [{ code: 'contract-creation', subjectIndex: 0 }] },
      fields: {
        contractAddress: SENDER,
        classHash: CLASS_HASH,
        salt: PUBLIC_KEY,
        constructorCalldata: [PUBLIC_KEY],
        nonce,
        tip: '0',
        resourceBounds: bounds(),
        nonceDataAvailabilityMode: 'l1',
        feeDataAvailabilityMode: 'l1'
      }
    },
    { family: 'starknet', chainId: CHAIN_ID, operation: 'transaction' }
  )
  assert.equal(parsed.fields.nonce, '0x0')
})

it('builds invoke APDUs from an entrypoint name when the unsigned transaction has no calls', () => {
  const calls = normalizeLedgerStarknetCalls([
    {
      to: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      entrypoint: 'transfer',
      calldata: [SENDER, '0x1', '0x0']
    }
  ])
  assert.equal(calls[0].selector, STARKNET_TRANSFER_SELECTOR)
  const apdus = planStarknetInvokeApdus({
    path: PATH,
    senderAddress: SENDER,
    chainIdFelt: '0x534e5f5345504f4c4941',
    nonce: '0x1',
    dataAvailabilityMode: '0x0',
    fees: fees(),
    calls
  })
  const call = apdus.find(apdu => apdu.p1 === 6)
  assert.equal(
    Buffer.from(call.data.subarray(32, 64)).toString('hex'),
    Buffer.from(starknetFeltBytes(calls[0].selector)).toString('hex')
  )
})

it('rejects more than 8 Ledger calls before an APDU is planned', () => {
  const call = { to: '0x3', selector: '0x4', calldata: ['0x0'] }
  assert.throws(
    () => normalizeLedgerStarknetCalls(Array.from({ length: 9 }, () => call)),
    /Invalid Ledger Starknet call count/
  )
})
