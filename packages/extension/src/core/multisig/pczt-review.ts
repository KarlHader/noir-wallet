import { sha256 } from '@noble/hashes/sha2'
import type * as WalletWasm from '@/lib/wasm-pkg/zcash_wallet_wasm'
import { bytesToHex } from '@/lib/bytes'

const FAIL = 'PCZT review is unavailable'
const MAX_ZATS = 2_100_000_000_000_000
const V6_GROUP_ID = 0xd884b698
const NU63_BRANCH = 0x37a5165b
const NU7_BRANCH = 0x77190ad9
const CONSENSUS_HEIGHTS = {
  mainnet: { nu63: 3_428_143, nu7: 3_543_405 },
  testnet: { nu63: 4_134_000, nu7: 4_465_026 }
} as const
const equal = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])
const zats = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ZATS
const u32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff

/** The tip must come from an independent chain query, not the PCZT or the local wallet DB. */
export function assertPcztConsensusPolicy(
  network: 'mainnet' | 'testnet',
  chainTipHeight: number,
  consensusBranchId: number,
  expiryHeight: number
): void {
  if (
    (network !== 'mainnet' && network !== 'testnet') ||
    !u32(chainTipHeight) ||
    !u32(consensusBranchId) ||
    !u32(expiryHeight) ||
    expiryHeight <= chainTipHeight
  )
    throw new Error(FAIL)

  const { nu63, nu7 } = CONSENSUS_HEIGHTS[network]
  if (chainTipHeight < nu63) throw new Error(FAIL)
  const isNu7 = chainTipHeight >= nu7
  if (consensusBranchId !== (isNu7 ? NU7_BRANCH : NU63_BRANCH)) throw new Error(FAIL)

  // The wallet DB target is its tip + 1. Accept an ordinary expiry only within
  // the pinned builder delta, and reject the whole pre-upgrade target window.
  const ordinaryDelta = isNu7 ? 120 : 40
  const ordinaryLimit = chainTipHeight + ordinaryDelta + 1
  if (expiryHeight > ordinaryLimit || (!isNu7 && ordinaryLimit >= nu7)) throw new Error(FAIL)
}

/** The WASM binding returns u8 indices; verify the entire action count before accepting them. */
export function readSigningActions(
  wasm: typeof WalletWasm.PcztTools,
  pczt: Uint8Array,
  groupVerifyingKey: Uint8Array
): { indices: Uint8Array; selectedAlphas: Uint8Array; actionAlphas: Uint8Array } {
  const actionAlphas = wasm.action_alphas(pczt)
  if (
    !(actionAlphas instanceof Uint8Array) ||
    actionAlphas.length === 0 ||
    actionAlphas.length % 32 !== 0 ||
    actionAlphas.length > 256 * 32 ||
    groupVerifyingKey.length !== 32
  )
    throw new Error(FAIL)
  const indices = wasm.signingSet(pczt, groupVerifyingKey)
  if (!(indices instanceof Uint8Array) || !indices.length) throw new Error(FAIL)
  let previous = -1
  const selectedAlphas = new Uint8Array(indices.length * 32)
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i]
    if (index <= previous || index >= actionAlphas.length / 32) throw new Error(FAIL)
    selectedAlphas.set(actionAlphas.subarray(index * 32, (index + 1) * 32), i * 32)
    previous = index
  }
  wasm.check_action_bindings(pczt, groupVerifyingKey, actionAlphas)
  return { indices: indices.slice(), selectedAlphas, actionAlphas }
}

export interface PcztReviewRequest {
  pczt: Uint8Array
  fvk: Uint8Array
  groupVerifyingKey: Uint8Array
  network: 'mainnet' | 'testnet'
  chainTipHeight: number
  recipient: string
  expectedRecipientRaw: Uint8Array
  amountZats: string
  memo: string
  maxFeeZats: string
}

export function reviewPreparedPczt(
  wasm: Pick<typeof WalletWasm, 'PcztTools'>,
  input: PcztReviewRequest
): {
  summary: { recipient: string; amount: string; memo: string; fee: string }
  pcztDigest: string
  signingIndices: Uint8Array
  expiryHeight: number
} {
  const {
    pczt,
    fvk,
    groupVerifyingKey,
    network,
    chainTipHeight,
    recipient,
    expectedRecipientRaw,
    amountZats,
    memo,
    maxFeeZats
  } = input
  if (
    !(pczt instanceof Uint8Array) ||
    !pczt.length ||
    !(fvk instanceof Uint8Array) ||
    fvk.length !== 96 ||
    !(expectedRecipientRaw instanceof Uint8Array) ||
    expectedRecipientRaw.length !== 43 ||
    !u32(chainTipHeight) ||
    (network !== 'mainnet' && network !== 'testnet') ||
    typeof recipient !== 'string' ||
    !recipient ||
    !/^[1-9][0-9]*$/.test(amountZats) ||
    !/^(0|[1-9][0-9]*)$/.test(maxFeeZats) ||
    !zats(Number(amountZats)) ||
    !zats(Number(maxFeeZats)) ||
    typeof memo !== 'string' ||
    new TextEncoder().encode(memo).length > 512
  )
    throw new Error(FAIL)

  const expectedMemo = new Uint8Array(512)
  if (memo) expectedMemo.set(new TextEncoder().encode(memo))
  else expectedMemo[0] = 0xf6

  try {
    wasm.PcztTools.check(pczt)
    const raw: unknown = wasm.PcztTools.review(pczt, fvk)
    if (!Array.isArray(raw) || raw.length !== 7) throw new Error(FAIL)
    const [digest, outputRows, spendRows, sentTotal, changeTotal, fee, headerValue] = raw
    if (
      !(digest instanceof Uint8Array) ||
      digest.length !== 32 ||
      !equal(digest, sha256(pczt)) ||
      !Array.isArray(outputRows) ||
      outputRows.length === 0 ||
      !Array.isArray(spendRows) ||
      spendRows.length === 0 ||
      !zats(sentTotal) ||
      !zats(changeTotal) ||
      !zats(fee) ||
      fee > Number(maxFeeZats) ||
      sentTotal !== Number(amountZats) ||
      !headerValue ||
      typeof headerValue !== 'object' ||
      Array.isArray(headerValue)
    )
      throw new Error(FAIL)
    const header = headerValue as Record<string, unknown>
    if (
      !Object.keys(header).every(key =>
        ['txVersion', 'versionGroupId', 'consensusBranchId', 'expiryHeight', 'coinType'].includes(
          key
        )
      ) ||
      header.txVersion !== 6 ||
      header.versionGroupId !== V6_GROUP_ID ||
      !u32(header.consensusBranchId) ||
      !u32(header.expiryHeight) ||
      header.coinType !== (network === 'mainnet' ? 133 : 1)
    )
      throw new Error(FAIL)
    assertPcztConsensusPolicy(
      network,
      chainTipHeight,
      header.consensusBranchId,
      header.expiryHeight
    )

    let paymentCount = 0
    let calculatedSent = 0
    let calculatedChange = 0
    for (const output of outputRows) {
      if (
        !Array.isArray(output) ||
        output.length !== 4 ||
        !(output[0] instanceof Uint8Array) ||
        output[0].length !== 43 ||
        !zats(output[1]) ||
        typeof output[2] !== 'boolean' ||
        (output[3] !== null && (!(output[3] instanceof Uint8Array) || output[3].length !== 512))
      )
        throw new Error(FAIL)
      const [rawAddress, value, isChange, rawMemo] = output as [
        Uint8Array,
        number,
        boolean,
        Uint8Array | null
      ]
      if (isChange) {
        calculatedChange += value
      } else {
        calculatedSent += value
        if (value > 0) {
          paymentCount++
          if (
            !equal(rawAddress, expectedRecipientRaw) ||
            value !== Number(amountZats) ||
            !rawMemo ||
            !equal(rawMemo, expectedMemo)
          )
            throw new Error(FAIL)
        }
      }
    }
    if (paymentCount !== 1 || calculatedSent !== sentTotal || calculatedChange !== changeTotal)
      throw new Error(FAIL)

    const { indices, actionAlphas } = readSigningActions(wasm.PcztTools, pczt, groupVerifyingKey)
    if (outputRows.length !== actionAlphas.length / 32 || spendRows.length !== indices.length)
      throw new Error(FAIL)
    let calculatedSpend = 0
    for (let i = 0; i < spendRows.length; i++) {
      const row = spendRows[i]
      if (
        !Array.isArray(row) ||
        row.length !== 3 ||
        row[0] !== indices[i] ||
        !(row[1] instanceof Uint8Array) ||
        row[1].length !== 32 ||
        !zats(row[2]) ||
        row[2] === 0
      )
        throw new Error(FAIL)
      calculatedSpend += row[2]
    }
    if (!zats(calculatedSpend) || calculatedSpend !== sentTotal + changeTotal + fee)
      throw new Error(FAIL)
    return {
      summary: { recipient, amount: amountZats, memo, fee: String(fee) },
      pcztDigest: bytesToHex(digest),
      signingIndices: indices,
      expiryHeight: header.expiryHeight
    }
  } catch {
    throw new Error(FAIL)
  }
}
