import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import {
  assertQuantusPreparedCallMatchesRequest,
  buildQuantusWasmTransferRequest,
  parsePreparedQuantusTransfer,
  parseQuantusTransferDetails,
  parseSignedQuantusCall
} from '../../../../src/infrastructure/keyring/multichain/quantus-signing-client.ts'
import { QUANTUS_NETWORKS } from '../../../../src/config/networks.ts'
import { parseQuantusBroadcastExtrinsicRequest } from '../../../../src/core/dapp/quantus-provider.ts'
import { blake2b } from '@noble/hashes/blake2b'
import { bytesToHex, hexToBytes } from '../../../../src/lib/bytes.ts'

const PACKAGE_DIR = '../../../../src/infrastructure/generated/wasm/multichain'
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT = 'qznFDa1qesTQ5UzEjGV4SDZTJJkqVmiqXUxkm9gMPU3JsuFFh'
const ERA_BLOCK_HASH = `0x${'22'.repeat(32)}`

async function packagedSession() {
  const module = await import(`${PACKAGE_DIR}/wallet_wasm.js`)
  const bytes = await readFile(new URL(`${PACKAGE_DIR}/wallet_wasm_bg.wasm`, import.meta.url))
  await module.default({ module_or_path: bytes })
  const engine = new module.WalletEngine()
  const vault = engine.importWallet(MNEMONIC, 'test-password', '')
  const { sessionId } = engine.unlock(vault, 'test-password')
  return { engine, sessionId }
}

function transferRequest(overrides = {}) {
  return buildQuantusWasmTransferRequest({
    chainId: QUANTUS_NETWORKS.mainnet.chainId,
    scheme: 'ml-dsa-87',
    accountIndex: 0,
    toAddress: RECIPIENT,
    amountRaw: '1000000000000',
    keepAlive: true,
    nonce: 0,
    tip: '0',
    period: 64,
    blockNumber: 1_024,
    genesisHash: QUANTUS_NETWORKS.mainnet.genesisHash,
    blockHash: ERA_BLOCK_HASH,
    specVersion: 153,
    transactionVersion: 1,
    ...overrides
  })
}

test.describe('Packaged Quantus prepare/confirm contract', () => {
  test('accepts the host request shape and confirms through confirmQuantusCall', async () => {
    const { engine, sessionId } = await packagedSession()

    const rawPrepared = engine.prepareQuantusTransfer(sessionId, transferRequest())
    const prepared = parsePreparedQuantusTransfer({
      chainId: QUANTUS_NETWORKS.mainnet.chainId,
      scheme: 'ml-dsa-87',
      accountIndex: 0,
      requestId: rawPrepared.requestId,
      account: rawPrepared.account,
      summary: rawPrepared.summary
    })

    expect(prepared.requestId).toBeGreaterThan(0)
    expect(prepared.account.address).toBe('qzna4bUiEiZdXQpwvSQDmM2y9rBPyJRS9iNm85jPgicM76kA8')
    expect(prepared.summary).toMatchObject({
      chainId: 'quantus:mainnet',
      network: 'mainnet',
      address: prepared.account.address,
      nonce: 0,
      tip: '0',
      period: 64,
      blockNumber: 1_024,
      allowImmortal: false
    })

    const signed = parseSignedQuantusCall(engine.confirmQuantusCall(sessionId, prepared.requestId))
    expect(signed).toMatchObject({
      address: prepared.account.address,
      accountId: prepared.account.accountId,
      scheme: 'ml-dsa-87',
      nonce: 0,
      callHash: prepared.summary.callHash
    })
    // Signed v4 extrinsic: compact length prefix, version byte 0x84, MultiAddress::Id.
    expect(signed.extrinsic.startsWith('0x')).toBe(true)
    expect(signed.extrinsic.slice(2)).toMatch(/^[0-9a-f]+84[0-9a-f]+$/)
    expect(signed.extrinsic.length).toBeGreaterThan(2 + 4_000 * 2)
    expect(parseQuantusBroadcastExtrinsicRequest([signed.extrinsic])).toBe(signed.extrinsic)
    expect(signed.extrinsicHash).toBe(
      `0x${bytesToHex(blake2b(hexToBytes(signed.extrinsic), { dkLen: 32 }))}`
    )

    // The engine also returns the encoded call and the transfer it re-encoded, so
    // the review can bind them to the requested transfer.
    expect(rawPrepared.summary.genesisHash).toBe(QUANTUS_NETWORKS.mainnet.genesisHash)
    expect(parseQuantusTransferDetails(rawPrepared.transfer)).toEqual({
      recipient: '0x7b8a2af845b16bc90b4889d1ba2393ae56a24d54f85dcfb561cf4779075ea66e',
      amount: '1000000000000',
      keepAlive: true
    })
    expect(rawPrepared.call).toMatch(/^0x[0-9a-f]+$/)
    expect(rawPrepared.call.length).toBe(2 + prepared.summary.callLength * 2)
    expect(() =>
      assertQuantusPreparedCallMatchesRequest({
        call: rawPrepared.call,
        transfer: rawPrepared.transfer,
        summary: prepared.summary,
        request: transferRequest()
      })
    ).not.toThrow()
  })

  test('rejects a prepared call or transfer that does not match the review', async () => {
    const { engine, sessionId } = await packagedSession()
    const request = transferRequest()
    const rawPrepared = engine.prepareQuantusTransfer(sessionId, request)
    const prepared = parsePreparedQuantusTransfer({
      chainId: QUANTUS_NETWORKS.mainnet.chainId,
      scheme: 'ml-dsa-87',
      accountIndex: 0,
      requestId: rawPrepared.requestId,
      account: rawPrepared.account,
      summary: rawPrepared.summary
    })
    engine.rejectSigningRequest(sessionId, rawPrepared.requestId)

    const base = {
      call: rawPrepared.call,
      transfer: rawPrepared.transfer,
      summary: prepared.summary,
      request
    }
    expect(() =>
      assertQuantusPreparedCallMatchesRequest({
        ...base,
        transfer: { ...rawPrepared.transfer, amount: '2000000000000' }
      })
    ).toThrow(/reviewed transfer/)
    expect(() =>
      assertQuantusPreparedCallMatchesRequest({
        ...base,
        transfer: { ...rawPrepared.transfer, keepAlive: false }
      })
    ).toThrow(/reviewed transfer/)
    expect(() =>
      assertQuantusPreparedCallMatchesRequest({
        ...base,
        summary: { ...prepared.summary, callHash: `0x${'11'.repeat(32)}` }
      })
    ).toThrow(/call hash/)
    expect(() =>
      assertQuantusPreparedCallMatchesRequest({
        ...base,
        summary: { ...prepared.summary, genesisHash: `0x${'22'.repeat(32)}` }
      })
    ).toThrow(/genesis hash/)
    expect(() => assertQuantusPreparedCallMatchesRequest({ ...base, call: '0x00' })).toThrow(
      /call length/
    )
  })

  test('ignores unsolicited signing coordinates, so the host must pin them', async () => {
    const { engine, sessionId } = await packagedSession()
    // `addressIndex`/`change` are not part of QuantusTransferRequest and the engine
    // silently ignores them instead of rejecting the payload: it always signs the
    // account's index-0 address. The host builder therefore emits the exact field
    // set and the prepare review must target that address.
    const raw = engine.prepareQuantusTransfer(sessionId, {
      ...transferRequest(),
      addressIndex: 7,
      change: true
    })
    expect(raw.account).toMatchObject({
      address: 'qzna4bUiEiZdXQpwvSQDmM2y9rBPyJRS9iNm85jPgicM76kA8',
      derivationPath: "m/44'/189189'/0'/0'/0'"
    })
    engine.rejectSigningRequest(sessionId, raw.requestId)

    expect(() =>
      engine.prepareQuantusTransfer(sessionId, transferRequest({ amountRaw: '0x10' }))
    ).toThrow()
  })
})
