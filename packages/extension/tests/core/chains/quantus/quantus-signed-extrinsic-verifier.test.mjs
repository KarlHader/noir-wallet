import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { expect } from '@playwright/test'

import { verifyQuantusSignedTransfer } from '../../../../src/infrastructure/chains/quantus/quantus-signed-extrinsic-verifier.ts'
import { buildQuantusWasmTransferRequest } from '../../../../src/infrastructure/keyring/multichain/quantus-signing-client.ts'
import { QUANTUS_NETWORKS } from '../../../../src/config/networks.ts'
import { QUANTUS_PROVISIONAL_FEE_LIMIT_RAW } from '../../../../src/core/keyring/domain/signing-summary.ts'
import { bytesToHex, hexToBytes } from '../../../../src/lib/bytes.ts'

const PACKAGE_DIR = '../../../../src/infrastructure/generated/wasm/multichain'
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT = 'qznFDa1qesTQ5UzEjGV4SDZTJJkqVmiqXUxkm9gMPU3JsuFFh'
const OTHER_RECIPIENT = 'qzjTEdq3Wd1d98kaeE1RTDPBBYBfY6XpfCtaLq97wmfcAD8M2'

async function signedTransfer({
  scheme = 'ml-dsa-87',
  amountRaw = '1000000000000',
  keepAlive = true,
  nonce = 3
} = {}) {
  const module = await import(`${PACKAGE_DIR}/wallet_wasm.js`)
  const bytes = await readFile(new URL(`${PACKAGE_DIR}/wallet_wasm_bg.wasm`, import.meta.url))
  await module.default({ module_or_path: bytes })
  const engine = new module.WalletEngine()
  const vault = engine.importWallet(MNEMONIC, 'test-password', '')
  const { sessionId } = engine.unlock(vault, 'test-password')
  const request = buildQuantusWasmTransferRequest({
    chainId: QUANTUS_NETWORKS.mainnet.chainId,
    scheme,
    accountIndex: 0,
    toAddress: RECIPIENT,
    amountRaw,
    keepAlive,
    nonce,
    tip: '0',
    period: 64,
    blockNumber: 1_024,
    genesisHash: QUANTUS_NETWORKS.mainnet.genesisHash,
    blockHash: `0x${'22'.repeat(32)}`,
    specVersion: 153,
    transactionVersion: 1
  })
  const raw = engine.prepareQuantusTransfer(sessionId, request)
  const signed = engine.confirmQuantusCall(sessionId, raw.requestId)
  return {
    raw,
    signed,
    summary: {
      schema: 'quantus.transfer.v1',
      chainId: QUANTUS_NETWORKS.mainnet.chainId,
      operation: 'transaction',
      review: { level: 'standard', issues: [] },
      fields: {
        signerAddress: raw.summary.address,
        signerAccountId: raw.summary.accountId,
        scheme,
        recipient: RECIPIENT,
        amountRaw,
        feeLimitRaw: QUANTUS_PROVISIONAL_FEE_LIMIT_RAW,
        keepAlive,
        nonce: String(raw.summary.nonce),
        tipRaw: raw.summary.tip,
        eraPeriod: raw.summary.period,
        blockNumber: raw.summary.blockNumber,
        callHash: raw.summary.callHash,
        callLength: raw.summary.callLength
      }
    }
  }
}

function withFields(summary, overrides) {
  return { ...summary, fields: { ...summary.fields, ...overrides } }
}

test.describe('Quantus signed-transfer verifier', () => {
  test('proves the reviewed binding of real packaged-engine bytes', async () => {
    const { signed, summary } = await signedTransfer()
    const verified = verifyQuantusSignedTransfer({
      summary,
      signedExtrinsicHex: signed.extrinsic,
      chainId: QUANTUS_NETWORKS.mainnet.chainId
    })
    expect(verified.extrinsicHash).toBe(signed.extrinsicHash)
    expect(verified).toMatchObject({ scheme: 'ml-dsa-87', nonce: 3, eraPeriod: 64 })
    expect(verified.signedExtrinsicHex).toBe(signed.extrinsic.toLowerCase())
  })

  test('proves the binding for the ML-DSA-65 scheme', async () => {
    const { signed, summary } = await signedTransfer({ scheme: 'ml-dsa-65', nonce: 9 })
    expect(
      verifyQuantusSignedTransfer({
        summary,
        signedExtrinsicHex: signed.extrinsic,
        chainId: QUANTUS_NETWORKS.mainnet.chainId
      })
    ).toMatchObject({ scheme: 'ml-dsa-65', nonce: 9 })
  })

  test('rejects a summary that does not describe the signed transfer', async () => {
    const { signed, summary } = await signedTransfer()
    const chainId = QUANTUS_NETWORKS.mainnet.chainId
    const cases = [
      withFields(summary, { amountRaw: '1000000000001' }),
      withFields(summary, { recipient: OTHER_RECIPIENT }),
      withFields(summary, { keepAlive: false }),
      withFields(summary, { nonce: '4' }),
      withFields(summary, { eraPeriod: 128 }),
      withFields(summary, { scheme: 'ml-dsa-65' }),
      withFields(summary, { signerAccountId: `0x${'11'.repeat(32)}` }),
      withFields(summary, { signerAddress: OTHER_RECIPIENT }),
      withFields(summary, { tipRaw: '1' }),
      withFields(summary, { callHash: `0x${'00'.repeat(32)}` }),
      withFields(summary, { callLength: 12 })
    ]
    for (const candidate of cases) {
      expect(() =>
        verifyQuantusSignedTransfer({ summary: candidate, signedExtrinsicHex: signed.extrinsic, chainId })
      ).toThrow()
    }
  })

  test('rejects mutated or unsupported extrinsic bytes', async () => {
    const { signed, summary } = await signedTransfer()
    const chainId = QUANTUS_NETWORKS.mainnet.chainId
    const bytes = hexToBytes(signed.extrinsic)
    const callStart = bytes.byteLength - summary.fields.callLength
    const mutations = {
      callAmount: (value) => {
        value[callStart + 40] ^= 0x01
      },
      callPallet: (value) => {
        value[callStart] = 0x07
      },
      callKeepAlive: (value) => {
        value[callStart + 1] = 0x04
      },
      version: (value) => {
        value[2] = 0x85
      },
      signerByte: value => {
        value[5] ^= 0x01
      },
      eraImmortal: (value) => {
        const eraOffset = callStart - 5
        value[eraOffset] = 0x00
        value[eraOffset + 1] = 0x00
      },
      eraPeriod: (value) => {
        value[callStart - 5] = (value[callStart - 5] & 0xf0) | 0x06
      },
      nonce: (value) => {
        value[callStart - 3] = 0x10
      },
      metadataMode: (value) => {
        value[callStart - 1] = 0x01
      }
    }
    for (const [label, mutate] of Object.entries(mutations)) {
      const candidate = Uint8Array.from(bytes)
      mutate(candidate)
      expect(
        () =>
          verifyQuantusSignedTransfer({
            summary,
            signedExtrinsicHex: `0x${bytesToHex(candidate)}`,
            chainId
          }),
        label
      ).toThrow()
    }
    // A truncated or over-long body must fail the SCALE length binding.
    for (const candidate of [bytes.subarray(0, bytes.byteLength - 1), Uint8Array.from([...bytes, 0x00])]) {
      expect(() =>
        verifyQuantusSignedTransfer({
          summary,
          signedExtrinsicHex: `0x${bytesToHex(candidate)}`,
          chainId
        })
      ).toThrow()
    }
    expect(() =>
      verifyQuantusSignedTransfer({ summary, signedExtrinsicHex: 'not-hex', chainId })
    ).toThrow()
  })
})
