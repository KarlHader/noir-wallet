import type { ChainId } from '@/core/chains/domain'
import { parseSigningSummary } from '@/core/keyring/domain/signing-summary-validation'
import type {
  PreparedSigningCommand,
  SigningCommandId,
  SigningResult
} from '@/core/keyring/ports/signing'
import {
  assertExactKeys,
  readArray,
  readLiteral,
  readRecord,
  readString,
  type UnknownRecord
} from './raw-wallet-engine'
import { canonicalContent, preparedCommand, sha256, utf8Bytes } from './signing-adapter-common'
import {
  parseRawStarknetAccount,
  readAddressIndex,
  readOptionalFeltList,
  readStarknetCalls,
  readStarknetChainId,
  readStarknetFelt,
  readStarknetResourceBounds,
  type RawDerivedStarknetAccount
} from './starknet-codecs'

export type StarknetSigningPreparePayload = Readonly<
  {
    kind: 'starknet-invoke' | 'starknet-deploy-account' | 'starknet-typed-data'
    chainId: ChainId
    accountIndex: number
    addressIndex: number
    classHash: string
  } & (
    | {
        kind: 'starknet-invoke'
        calls: readonly UnknownRecord[]
        nonce: string
        resourceBounds: UnknownRecord
        tip?: string
        nonceDataAvailabilityMode?: string
        feeDataAvailabilityMode?: string
        paymasterData?: readonly string[]
        accountDeploymentData?: readonly string[]
        proofFacts?: readonly string[]
        proof?: string
      }
    | {
        kind: 'starknet-deploy-account'
        nonce: string
        resourceBounds: UnknownRecord
        salt?: string
        tip?: string
        nonceDataAvailabilityMode?: string
        feeDataAvailabilityMode?: string
        paymasterData?: readonly string[]
      }
    | {
        kind: 'starknet-typed-data'
        typedData: string
      }
  )
>

export interface AdaptedStarknetPreparedSigning {
  readonly rawRequestId: number
  readonly kind: StarknetSigningPreparePayload['kind']
  readonly account: RawDerivedStarknetAccount
  readonly prepared: PreparedSigningCommand
}

function readMode(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return readLiteral(value, ['l1', 'l2'], label)
}

function commonAccount(record: UnknownRecord) {
  return {
    chainId: readStarknetChainId(record.chainId) as ChainId,
    accountIndex: readAddressIndex(record.accountIndex, 'accountIndex'),
    addressIndex: readAddressIndex(record.addressIndex, 'addressIndex'),
    classHash: readStarknetFelt(record.classHash, 'classHash')
  }
}

export function parseStarknetSigningPreparePayload(value: unknown): StarknetSigningPreparePayload {
  const record = readRecord(value, 'signing.prepare payload')
  const kind = readLiteral(
    record.kind,
    ['starknet-invoke', 'starknet-deploy-account', 'starknet-typed-data'],
    'signing.prepare kind'
  )
  if (kind === 'starknet-invoke') {
    assertExactKeys(
      record,
      [
        'kind',
        'chainId',
        'accountIndex',
        'addressIndex',
        'classHash',
        'calls',
        'nonce',
        'resourceBounds'
      ],
      [
        'tip',
        'nonceDataAvailabilityMode',
        'feeDataAvailabilityMode',
        'paymasterData',
        'accountDeploymentData',
        'proofFacts',
        'proof'
      ],
      'payload'
    )
    return Object.freeze({
      kind,
      ...commonAccount(record),
      calls: readStarknetCalls(record.calls),
      nonce: readStarknetFelt(record.nonce, 'nonce'),
      resourceBounds: readStarknetResourceBounds(record.resourceBounds),
      ...(record.tip === undefined ? {} : { tip: readString(record.tip, 'tip', 32) }),
      ...(readMode(record.nonceDataAvailabilityMode, 'nonceDataAvailabilityMode') === undefined
        ? {}
        : {
            nonceDataAvailabilityMode: readMode(
              record.nonceDataAvailabilityMode,
              'nonceDataAvailabilityMode'
            )
          }),
      ...(readMode(record.feeDataAvailabilityMode, 'feeDataAvailabilityMode') === undefined
        ? {}
        : {
            feeDataAvailabilityMode: readMode(
              record.feeDataAvailabilityMode,
              'feeDataAvailabilityMode'
            )
          }),
      ...(record.paymasterData === undefined
        ? {}
        : { paymasterData: readOptionalFeltList(record.paymasterData, 'paymasterData') }),
      ...(record.accountDeploymentData === undefined
        ? {}
        : {
            accountDeploymentData: readOptionalFeltList(
              record.accountDeploymentData,
              'accountDeploymentData'
            )
          }),
      ...(record.proofFacts === undefined
        ? {}
        : { proofFacts: readOptionalFeltList(record.proofFacts, 'proofFacts') }),
      ...(record.proof === undefined ? {} : { proof: readString(record.proof, 'proof', 131_072) })
    })
  }
  if (kind === 'starknet-deploy-account') {
    assertExactKeys(
      record,
      ['kind', 'chainId', 'accountIndex', 'addressIndex', 'classHash', 'nonce', 'resourceBounds'],
      ['salt', 'tip', 'nonceDataAvailabilityMode', 'feeDataAvailabilityMode', 'paymasterData'],
      'payload'
    )
    return Object.freeze({
      kind,
      ...commonAccount(record),
      nonce: readStarknetFelt(record.nonce, 'nonce'),
      resourceBounds: readStarknetResourceBounds(record.resourceBounds),
      ...(record.salt === undefined ? {} : { salt: readStarknetFelt(record.salt, 'salt') }),
      ...(record.tip === undefined ? {} : { tip: readString(record.tip, 'tip', 32) }),
      ...(readMode(record.nonceDataAvailabilityMode, 'nonceDataAvailabilityMode') === undefined
        ? {}
        : {
            nonceDataAvailabilityMode: readMode(
              record.nonceDataAvailabilityMode,
              'nonceDataAvailabilityMode'
            )
          }),
      ...(readMode(record.feeDataAvailabilityMode, 'feeDataAvailabilityMode') === undefined
        ? {}
        : {
            feeDataAvailabilityMode: readMode(
              record.feeDataAvailabilityMode,
              'feeDataAvailabilityMode'
            )
          }),
      ...(record.paymasterData === undefined
        ? {}
        : { paymasterData: readOptionalFeltList(record.paymasterData, 'paymasterData') })
    })
  }
  assertExactKeys(
    record,
    ['kind', 'chainId', 'accountIndex', 'addressIndex', 'classHash', 'typedData'],
    [],
    'payload'
  )
  return Object.freeze({
    kind,
    ...commonAccount(record),
    typedData: readString(record.typedData, 'typedData', 65_536)
  })
}

export function starknetSessionRequestJson(payload: StarknetSigningPreparePayload): string {
  const { kind: _kind, ...request } = payload
  return JSON.stringify(request)
}

function caution(
  code: 'unrecognized-call' | 'contract-creation' | 'opaque-message',
  count: number
) {
  return Object.freeze({
    level: 'caution' as const,
    issues: Object.freeze(
      Array.from({ length: count }, (_, subjectIndex) => Object.freeze({ code, subjectIndex }))
    )
  })
}

function parsePrepared(value: unknown) {
  const record = readRecord(value, 'Prepared Starknet signing')
  assertExactKeys(
    record,
    ['requestId', 'account', 'signingHash', 'summary'],
    [],
    'Prepared Starknet signing'
  )
  return {
    requestId: readAddressIndex(record.requestId, 'requestId'),
    account: parseRawStarknetAccount(record.account),
    signingHash: readStarknetFelt(record.signingHash, 'signingHash'),
    summary: readRecord(record.summary, 'summary')
  }
}

async function adaptInvoke(
  raw: unknown,
  payload: Extract<StarknetSigningPreparePayload, { kind: 'starknet-invoke' }>,
  commandId: SigningCommandId,
  expiresAt: number
): Promise<AdaptedStarknetPreparedSigning> {
  const prepared = parsePrepared(raw)
  const summary = prepared.summary
  if (summary.chainId !== payload.chainId) throw new Error('Starknet invoke chain does not match')
  const calls = readArray(
    summary.calls,
    'summary.calls',
    item => readRecord(item, 'summary call'),
    128
  )
  const parsed = parseSigningSummary(
    {
      schema: 'starknet.invoke.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: caution('unrecognized-call', calls.length),
      fields: {
        senderAddress: summary.senderAddress,
        nonce: summary.nonce,
        tip: summary.tip,
        resourceBounds: summary.resourceBounds,
        calls: calls.map(call => ({
          to: call.to,
          selector: call.selector,
          entrypoint: call.entrypoint,
          calldata: call.calldata
        })),
        nonceDataAvailabilityMode: summary.nonceDataAvailabilityMode,
        feeDataAvailabilityMode: summary.feeDataAvailabilityMode
      }
    },
    { family: 'starknet', chainId: payload.chainId, operation: 'transaction' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account: prepared.account,
    prepared: preparedCommand(
      commandId,
      payload.chainId,
      'transaction',
      parsed,
      await sha256(utf8Bytes(JSON.stringify(payload))),
      expiresAt
    )
  })
}

async function adaptDeploy(
  raw: unknown,
  payload: Extract<StarknetSigningPreparePayload, { kind: 'starknet-deploy-account' }>,
  commandId: SigningCommandId,
  expiresAt: number
): Promise<AdaptedStarknetPreparedSigning> {
  const prepared = parsePrepared(raw)
  const summary = prepared.summary
  if (summary.chainId !== payload.chainId) throw new Error('Starknet deploy chain does not match')
  const parsed = parseSigningSummary(
    {
      schema: 'starknet.deploy-account.v1',
      chainId: payload.chainId,
      operation: 'transaction',
      review: caution('contract-creation', 1),
      fields: {
        contractAddress: summary.contractAddress,
        classHash: summary.classHash,
        salt: summary.salt,
        constructorCalldata: summary.constructorCalldata,
        nonce: summary.nonce,
        tip: summary.tip,
        resourceBounds: summary.resourceBounds,
        nonceDataAvailabilityMode: summary.nonceDataAvailabilityMode,
        feeDataAvailabilityMode: summary.feeDataAvailabilityMode
      }
    },
    { family: 'starknet', chainId: payload.chainId, operation: 'transaction' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account: prepared.account,
    prepared: preparedCommand(
      commandId,
      payload.chainId,
      'transaction',
      parsed,
      await sha256(utf8Bytes(JSON.stringify(payload))),
      expiresAt
    )
  })
}

async function adaptTypedData(
  raw: unknown,
  payload: Extract<StarknetSigningPreparePayload, { kind: 'starknet-typed-data' }>,
  commandId: SigningCommandId,
  expiresAt: number
): Promise<AdaptedStarknetPreparedSigning> {
  const prepared = parsePrepared(raw)
  const summary = prepared.summary
  if (summary.chainId !== payload.chainId)
    throw new Error('Starknet typed data chain does not match')
  const typedData = await canonicalContent(utf8Bytes(JSON.stringify(summary.typedData)), 'utf8')
  const parsed = parseSigningSummary(
    {
      schema: 'starknet.typed-data.v1',
      chainId: payload.chainId,
      operation: 'message',
      review: caution('opaque-message', 1),
      fields: {
        accountAddress: summary.accountAddress,
        publicKey: summary.publicKey,
        typedData
      }
    },
    { family: 'starknet', chainId: payload.chainId, operation: 'message' }
  )
  return Object.freeze({
    rawRequestId: prepared.requestId,
    kind: payload.kind,
    account: prepared.account,
    prepared: preparedCommand(
      commandId,
      payload.chainId,
      'message',
      parsed,
      await sha256(utf8Bytes(payload.typedData)),
      expiresAt
    )
  })
}

export async function adaptStarknetPreparedSigning(
  raw: unknown,
  payload: StarknetSigningPreparePayload,
  commandId: SigningCommandId,
  expiresAt: number
): Promise<AdaptedStarknetPreparedSigning> {
  switch (payload.kind) {
    case 'starknet-invoke':
      return adaptInvoke(raw, payload, commandId, expiresAt)
    case 'starknet-deploy-account':
      return adaptDeploy(raw, payload, commandId, expiresAt)
    case 'starknet-typed-data':
      return adaptTypedData(raw, payload, commandId, expiresAt)
  }
}

function signaturePair(value: unknown): readonly [string, string] {
  const signature = readArray(value, 'signature', item => readStarknetFelt(item, 'signature'), 2)
  if (signature.length !== 2) throw new Error('Starknet signature must be [r, s]')
  return [signature[0], signature[1]]
}

export function adaptStarknetSignedResult(
  kind: StarknetSigningPreparePayload['kind'],
  raw: unknown,
  account: RawDerivedStarknetAccount
): SigningResult {
  const record = readRecord(raw, 'Signed Starknet result')
  if (kind === 'starknet-typed-data') {
    assertExactKeys(
      record,
      ['accountAddress', 'messageHash', 'signature', 'typedData'],
      [],
      'Signed Starknet typed data'
    )
    if (record.accountAddress !== account.address) {
      throw new Error('Signed Starknet account does not match')
    }
    const signature = signaturePair(record.signature)
    return Object.freeze({
      kind: 'signature',
      signature: Object.freeze({ encoding: 'utf8', value: JSON.stringify(signature) }),
      publicKey: account.publicKey,
      address: account.address
    })
  }
  const transactionKey =
    kind === 'starknet-invoke' ? 'invokeTransaction' : 'deployAccountTransaction'
  assertExactKeys(
    record,
    ['transactionHash', 'signature', transactionKey],
    kind === 'starknet-deploy-account' ? ['contractAddress'] : [],
    'Signed Starknet transaction'
  )
  signaturePair(record.signature)
  return Object.freeze({
    kind: 'signed-payload',
    transactionId: readStarknetFelt(record.transactionHash, 'transactionHash'),
    payload: Object.freeze({
      encoding: 'utf8' as const,
      value: JSON.stringify(record[transactionKey])
    })
  })
}
