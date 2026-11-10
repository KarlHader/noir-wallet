import type { ChainId } from '@/core/chains/domain'
import { parseChainId } from '@/core/chains/registry'
import type {
  PreparedSigningCommand,
  SigningCommandId,
  SigningResult
} from '@/core/keyring/ports/signing'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import type {
  CanonicalContent,
  SigningReview,
  SigningReviewIssue
} from '@/core/keyring/domain/signing-summary'
import {
  MAX_BIP32_INDEX,
  assertExactKeys,
  readBoolean,
  readRecord,
  readSafeInteger,
  readString,
  type UnknownRecord
} from './raw-wallet-engine'
import {
  isDashChainId,
  parseRawDashAccount,
  parseRawDashMessageSummary,
  parseRawDashPsbtSummary,
  parseRawSignedDashMessage,
  parseRawSignedDashPsbt,
  assertRawDashAccountMatches,
  type RawDashAccount
} from './dash-codecs'
import type { DashSigningPreparePayload } from './worker-dash-runtime'

const textEncoder = new TextEncoder()
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true })

export type { DashSigningPreparePayload }

function readCanonicalBase64(value: unknown, label: string, maximum: number): string {
  const parsed = readString(value, label, maximum)
  if (
    parsed.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  return parsed
}

function readMessage(value: unknown, label: string, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    throw new Error(`${label} must be bounded bytes`)
  }
  return new Uint8Array(value)
}

export function parseDashSigningPreparePayload(record: UnknownRecord): DashSigningPreparePayload {
  const kind = record.kind
  if (kind === 'dash-psbt') {
    assertExactKeys(record, ['kind', 'chainId', 'accountIndex', 'psbt'], [], 'payload')
    const chainId = readString(record.chainId, 'chainId', 64)
    if (!isDashChainId(chainId)) throw new Error('Unsupported Dash chain ID')
    return Object.freeze({
      kind,
      chainId: parseChainId(chainId).id,
      accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
      psbt: readCanonicalBase64(record.psbt, 'psbt', 2 * 1024 * 1024)
    })
  }
  if (kind !== 'dash-message') throw new Error('Unsupported Dash signing payload')
  assertExactKeys(
    record,
    ['kind', 'chainId', 'accountIndex', 'change', 'addressIndex', 'message'],
    [],
    'payload'
  )
  const chainId = readString(record.chainId, 'chainId', 64)
  if (!isDashChainId(chainId)) throw new Error('Unsupported Dash chain ID')
  return Object.freeze({
    kind,
    chainId: parseChainId(chainId).id,
    accountIndex: readSafeInteger(record.accountIndex, 'accountIndex', MAX_BIP32_INDEX),
    change: readBoolean(record.change, 'change'),
    addressIndex: readSafeInteger(record.addressIndex, 'addressIndex', MAX_BIP32_INDEX),
    message: readMessage(record.message, 'message', 4 * 1024)
  })
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, character => character.charCodeAt(0))
}

async function canonicalContent(bytes: Uint8Array): Promise<CanonicalContent> {
  let encoding: CanonicalContent['encoding'] = 'utf8'
  let value: string
  try {
    const decoded = strictTextDecoder.decode(bytes)
    const encoded = textEncoder.encode(decoded)
    if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) {
      throw new Error('non-canonical UTF-8')
    }
    value = decoded
  } catch {
    encoding = 'hex'
    value = `0x${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return Object.freeze({
    encoding,
    value,
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes)
  })
}

function review(issues: readonly SigningReviewIssue[], blocked = false): SigningReview {
  return Object.freeze({
    level: issues.length === 0 ? 'standard' : blocked ? 'blocked' : 'caution',
    issues: Object.freeze(issues)
  })
}

function preparedCommand(
  signingCommandId: SigningCommandId,
  chainId: ChainId,
  operation: 'transaction' | 'message',
  summary: ReturnType<typeof parseSigningSummary>,
  fingerprint: string,
  expiresAt: number
): PreparedSigningCommand {
  return Object.freeze({
    commandId: signingCommandId,
    chainId,
    operation,
    summary,
    payloadFingerprint: Object.freeze({ algorithm: 'sha256' as const, digestHex: fingerprint }),
    execution: Object.freeze({ kind: 'internal' as const }),
    expiresAt
  })
}

export async function adaptDashPreparedSigning(
  raw: unknown,
  payload: DashSigningPreparePayload,
  signingCommandId: SigningCommandId,
  expiresAt: number,
  account: RawDashAccount,
  imported: boolean
): Promise<{
  readonly rawRequestId: number
  readonly kind: DashSigningPreparePayload['kind']
  readonly account: RawDashAccount
  readonly prepared: PreparedSigningCommand
}> {
  const prepared = readRecord(raw, 'PreparedDashSigning')
  const requestId = readSafeInteger(prepared.requestId, 'PreparedDashSigning.requestId')
  if (requestId === 0) throw new Error('PreparedDashSigning.requestId must be positive')
  if (payload.kind === 'dash-psbt') {
    assertExactKeys(prepared, ['requestId', 'summary'], [], 'PreparedDashPsbt')
    const summary = parseRawDashPsbtSummary(prepared.summary)
    if (summary.chainId !== payload.chainId || summary.accountIndex !== payload.accountIndex) {
      throw new Error('Prepared Dash PSBT does not match the selected account')
    }
    assertRawDashAccountMatches(account, payload.chainId, payload.accountIndex, false, 0, imported)
    if (!summary.inputs.some(input => input.walletOwned)) {
      throw new Error('Prepared Dash PSBT has no input owned by the selected account')
    }
    const issues: SigningReviewIssue[] = []
    if (summary.inputs.some(input => !input.walletOwned)) {
      issues.push(Object.freeze({ code: 'external-input' }))
    }
    if (summary.inputs.some(input => input.sighashType !== 'SIGHASH_ALL')) {
      issues.push(Object.freeze({ code: 'non-default-sighash' }))
    }
    summary.outputs.forEach(output => {
      if (output.address === null && !output.isChange) {
        issues.push(Object.freeze({ code: 'unknown-output', subjectIndex: output.index }))
      }
    })
    const parsed = parseSigningSummary(
      {
        schema: 'dash.psbt.v1',
        chainId: payload.chainId,
        operation: 'transaction',
        review: review(
          issues,
          summary.outputs.some(output => output.address === null && !output.isChange)
        ),
        fields: {
          psbtVersion: 0,
          signer: account.address,
          accountIndex: payload.accountIndex,
          inputs: summary.inputs.map(input =>
            Object.freeze({
              index: input.index,
              transactionId: input.txid,
              outputIndex: input.vout,
              amountDuffs: input.valueDuffs,
              sequence: input.sequence,
              scriptType: 'p2pkh' as const,
              sighashType: input.sighashType,
              ownership: input.walletOwned ? ('signing-account' as const) : ('external' as const),
              derivationPath: input.derivationPath
            })
          ),
          outputs: summary.outputs.map(output =>
            Object.freeze({
              index: output.index,
              address: output.address,
              scriptPubKeyHex: output.scriptPubKey,
              amountDuffs: output.valueDuffs,
              classification: output.isChange
                ? ('change' as const)
                : output.address
                  ? ('recipient' as const)
                  : ('unknown' as const),
              derivationPath: output.derivationPath
            })
          ),
          signingInputIndexes: summary.inputs
            .filter(input => input.walletOwned)
            .map(input => input.index),
          totalInputDuffs: summary.totalInputDuffs,
          totalOutputDuffs: summary.totalOutputDuffs,
          feeDuffs: summary.feeDuffs
        }
      },
      { family: 'dash', chainId: payload.chainId, operation: 'transaction' }
    )
    return Object.freeze({
      rawRequestId: requestId,
      kind: payload.kind,
      account,
      prepared: preparedCommand(
        signingCommandId,
        payload.chainId,
        'transaction',
        parsed,
        await sha256(decodeBase64(payload.psbt)),
        expiresAt
      )
    })
  }
  assertExactKeys(prepared, ['requestId', 'account', 'summary'], [], 'PreparedDashMessage')
  const preparedAccount = parseRawDashAccount(prepared.account)
  if (
    preparedAccount.address !== account.address ||
    preparedAccount.publicKey !== account.publicKey ||
    preparedAccount.derivationPath !== account.derivationPath
  ) {
    throw new Error('Prepared Dash message account does not match the selected account')
  }
  assertRawDashAccountMatches(
    account,
    payload.chainId,
    payload.accountIndex,
    payload.change,
    payload.addressIndex,
    imported
  )
  const summary = parseRawDashMessageSummary(prepared.summary)
  if (
    summary.chainId !== payload.chainId ||
    summary.signer !== account.address ||
    summary.byteLength !== payload.message.byteLength
  ) {
    throw new Error('Prepared Dash message does not match the selected account')
  }
  const message = await canonicalContent(payload.message)
  const issues =
    message.encoding === 'utf8' ? [] : [Object.freeze({ code: 'opaque-message' as const })]
  const parsed = parseSigningSummary(
    {
      schema: 'dash.message.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: review(issues),
      fields: {
        signer: account.address,
        message,
        messageHash: summary.messageHash
      }
    },
    { family: 'dash', chainId: payload.chainId, operation: 'message' }
  )
  return Object.freeze({
    rawRequestId: requestId,
    kind: payload.kind,
    account,
    prepared: preparedCommand(
      signingCommandId,
      payload.chainId,
      'message',
      parsed,
      await sha256(payload.message),
      expiresAt
    )
  })
}

export function adaptDashSignedResult(
  kind: DashSigningPreparePayload['kind'],
  raw: unknown,
  account: RawDashAccount
): SigningResult {
  if (kind === 'dash-psbt') {
    const signed = parseRawSignedDashPsbt(raw)
    return Object.freeze({
      kind: 'signed-payload',
      payload: Object.freeze({ encoding: 'base64' as const, value: signed.psbt }),
      transactionId: signed.unsignedTxid
    })
  }
  const signed = parseRawSignedDashMessage(raw)
  if (signed.address !== account.address) {
    throw new Error('Signed Dash message address does not match the prepared account')
  }
  return Object.freeze({
    kind: 'signature',
    signature: Object.freeze({ encoding: 'base64' as const, value: signed.signature }),
    publicKey: account.publicKey,
    address: account.address
  })
}
