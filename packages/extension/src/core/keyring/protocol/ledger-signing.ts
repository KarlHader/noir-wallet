import { parseChainId, getBitcoinChainId } from '@/core/chains/registry'
import { DASH_CHAIN_IDS } from '@/core/chains/registry/chain-ids'
import { validateLedgerDashDerivationPath } from '@/core/wallet/ledger-derivation-path'
import { validateLedgerStarknetDerivationPath } from '@/core/wallet/ledger-derivation-path'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId, parseSigningSummary, type SigningSummary } from '@/core/keyring/domain'
import { validateLedgerEvmDerivationPath } from '@/core/wallet/ledger-derivation-path'
import {
  assertExactKeys,
  readBoundedString,
  readRecord,
  readSafeInteger,
  readString
} from '@/core/keyring/domain/signing-summary-validation'

export type LedgerEvmSigningRequest =
  | Readonly<{
      kind: 'transaction'
      derivationPath: string
      expectedAddress: string
      unsignedTransactionHex: string
    }>
  | Readonly<{
      kind: 'personal-sign'
      derivationPath: string
      expectedAddress: string
      messageHex: string
    }>
  | Readonly<{
      kind: 'typed-data'
      derivationPath: string
      expectedAddress: string
      typedData: Readonly<Record<string, unknown>>
    }>
export interface LedgerEvmSigningResponse {
  readonly signatureHex: string
}

interface LedgerBitcoinAccountBinding {
  readonly accountPath: string
  readonly masterFingerprintHex: string
  readonly expectedAddress: string
  readonly network: 'mainnet' | 'testnet'
}
export type LedgerBitcoinSigningRequest =
  | (LedgerBitcoinAccountBinding & Readonly<{ kind: 'psbt'; psbtBase64: string }>)
  | (LedgerBitcoinAccountBinding & Readonly<{ kind: 'bip322-simple'; message: string }>)
export type LedgerBitcoinSigningResponse =
  | Readonly<{ kind: 'psbt'; signedPsbtBase64: string }>
  | Readonly<{ kind: 'bip322-simple'; signature: string }>

export type LedgerSolanaSigningRequest = Readonly<{
  kind: 'solana-transaction'
  chainId: string
  path: string
  transactionBase64: string
  expectedPublicKey: string
}>
export type LedgerSolanaSigningResponse = Readonly<{
  kind: 'solana-transaction'
  signedTransactionBase64: string
  publicKey: string
  signature: string
}>

export type LedgerNearSigningRequest = Readonly<{
  kind: 'near-transaction' | 'near-nep413-message'
  chainId: 'near:mainnet' | 'near:testnet'
  path: string
  payloadBase64: string
  expectedPublicKey: string
}>
export type LedgerNearSigningResponse = Readonly<{
  kind: LedgerNearSigningRequest['kind']
  signatureBase64: string
  publicKey: string
}>

export type LedgerDashSigningRequest =
  | Readonly<{
      kind: 'dash-psbt'
      chainId: (typeof DASH_CHAIN_IDS)['mainnet']
      accountPath: string
      xpub: string
      expectedAddress: string
      psbtBase64: string
    }>
  | Readonly<{
      kind: 'dash-message'
      chainId: (typeof DASH_CHAIN_IDS)['mainnet']
      accountPath: string
      expectedAddress: string
      message: string
    }>
export type LedgerStarknetChainId = 'starknet:SN_MAIN' | 'starknet:SN_SEPOLIA'
interface LedgerStarknetAccountBinding {
  readonly chainId: LedgerStarknetChainId
  readonly derivationPath: string
  readonly publicKey: string
  readonly address: string
  readonly classHash: string
  readonly blindSigning: boolean
}
export type LedgerStarknetSigningRequest =
  | (LedgerStarknetAccountBinding &
      Readonly<{
        kind: 'starknet-invoke'
        transactionHash: string
        transaction: Readonly<Record<string, unknown>>
      }>)
  | (LedgerStarknetAccountBinding &
      Readonly<{
        kind: 'starknet-deploy-account'
        transactionHash: string
        transaction: Readonly<Record<string, unknown>>
      }>)
  | (LedgerStarknetAccountBinding &
      Readonly<{
        kind: 'starknet-typed-data'
        messageHash: string
      }>)
export type LedgerStarknetSigningResponse = Readonly<{
  kind: LedgerStarknetSigningRequest['kind']
  publicKey: string
  signature: readonly [string, string]
}>

export type LedgerDashSigningResponse =
  | Readonly<{
      kind: 'dash-psbt'
      signedTransactionHex: string
    }>
  | Readonly<{
      kind: 'dash-message'
      signature: string
    }>

export type LedgerDeviceSigningRequest =
  | LedgerEvmSigningRequest
  | LedgerBitcoinSigningRequest
  | LedgerSolanaSigningRequest
  | LedgerNearSigningRequest
  | LedgerDashSigningRequest
  | LedgerStarknetSigningRequest
export type LedgerDeviceSigningResponse =
  | LedgerEvmSigningResponse
  | LedgerBitcoinSigningResponse
  | LedgerSolanaSigningResponse
  | LedgerNearSigningResponse
  | LedgerDashSigningResponse
  | LedgerStarknetSigningResponse

export interface LedgerPendingSigning {
  readonly requestId: string
  readonly request: LedgerDeviceSigningRequest
  readonly scope: {
    readonly keyDomainId: string
    readonly accountId: string
    readonly chainId: string
  }
  readonly payloadFingerprint: { readonly algorithm: 'sha256'; readonly digestHex: string }
  readonly expiresAt: number
  readonly origin?: string
  readonly summary: SigningSummary
  readonly requestDigest: string
  readonly tabId?: number
}

function bounded(value: unknown, label: string, maximum = 1_500_000): string {
  return readString(value, label, maximum)
}

function request(value: unknown, chainId: string): LedgerDeviceSigningRequest {
  const item = readRecord(value, 'Ledger signing request')
  const commonEvm = ['kind', 'derivationPath', 'expectedAddress']
  if (item.kind === 'transaction' || item.kind === 'personal-sign' || item.kind === 'typed-data') {
    const field =
      item.kind === 'transaction'
        ? 'unsignedTransactionHex'
        : item.kind === 'personal-sign'
          ? 'messageHex'
          : 'typedData'
    assertExactKeys(item, [...commonEvm, field], [], 'Ledger EVM request')
    if (parseChainId(chainId).namespace !== 'eip155')
      throw new Error('Ledger request chain does not match EVM')
    const derivationPath = bounded(item.derivationPath, 'Ledger derivation path', 128)
    const expectedAddress = bounded(item.expectedAddress, 'Ledger address', 42)
    if (!/^0x[0-9a-fA-F]{40}$/.test(expectedAddress))
      throw new Error('Invalid Ledger EVM account binding')
    validateLedgerEvmDerivationPath(derivationPath)
    if (item.kind === 'typed-data') {
      const typedData = readRecord(item.typedData, 'Ledger typed data')
      if (JSON.stringify(typedData).length > 1_048_576)
        throw new Error('Ledger typed data is too large')
      return { kind: item.kind, derivationPath, expectedAddress, typedData }
    }
    const payload = bounded(item[field], `Ledger ${field}`)
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(payload)) throw new Error(`Invalid Ledger ${field}`)
    return item.kind === 'transaction'
      ? { kind: item.kind, derivationPath, expectedAddress, unsignedTransactionHex: payload }
      : { kind: item.kind, derivationPath, expectedAddress, messageHex: payload }
  }
  if (item.kind === 'psbt' || item.kind === 'bip322-simple') {
    const field = item.kind === 'psbt' ? 'psbtBase64' : 'message'
    assertExactKeys(
      item,
      ['kind', 'accountPath', 'masterFingerprintHex', 'expectedAddress', 'network', field],
      [],
      'Ledger Bitcoin request'
    )
    if (item.network !== 'mainnet' && item.network !== 'testnet')
      throw new Error('Invalid Ledger Bitcoin network')
    if (chainId !== getBitcoinChainId(item.network))
      throw new Error('Ledger Bitcoin network does not match request chain')
    const accountPath = bounded(item.accountPath, 'Ledger account path', 128)
    const masterFingerprintHex = bounded(item.masterFingerprintHex, 'Ledger fingerprint', 8)
    const expectedAddress = bounded(item.expectedAddress, 'Ledger address', 128)
    if (
      !new RegExp(`^m/84'/${item.network === 'mainnet' ? 0 : 1}'/(?:0|[1-9][0-9]*)'$`).test(
        accountPath
      ) ||
      !/^[0-9a-fA-F]{8}$/.test(masterFingerprintHex)
    )
      throw new Error('Invalid Ledger Bitcoin account binding')
    const payload =
      item.kind === 'psbt'
        ? bounded(item.psbtBase64, 'Ledger psbtBase64')
        : readBoundedString(item.message, 'Ledger message', 1_500_000)
    return item.kind === 'psbt'
      ? {
          kind: item.kind,
          accountPath,
          masterFingerprintHex,
          expectedAddress,
          network: item.network,
          psbtBase64: payload
        }
      : {
          kind: item.kind,
          accountPath,
          masterFingerprintHex,
          expectedAddress,
          network: item.network,
          message: payload
        }
  }
  if (item.kind === 'solana-transaction') {
    assertExactKeys(
      item,
      ['kind', 'chainId', 'path', 'transactionBase64', 'expectedPublicKey'],
      [],
      'Ledger Solana request'
    )
    if (item.chainId !== chainId || parseChainId(chainId).namespace !== 'solana')
      throw new Error('Ledger Solana chain does not match request')
    return {
      kind: item.kind,
      chainId,
      path: bounded(item.path, 'Ledger path', 128),
      transactionBase64: bounded(item.transactionBase64, 'Ledger Solana transaction'),
      expectedPublicKey: bounded(item.expectedPublicKey, 'Ledger Solana key', 128)
    }
  }
  if (item.kind === 'near-transaction' || item.kind === 'near-nep413-message') {
    assertExactKeys(
      item,
      ['kind', 'chainId', 'path', 'payloadBase64', 'expectedPublicKey'],
      [],
      'Ledger NEAR request'
    )
    if (item.chainId !== chainId || (chainId !== 'near:mainnet' && chainId !== 'near:testnet'))
      throw new Error('Ledger NEAR chain does not match request')
    return {
      kind: item.kind,
      chainId,
      path: bounded(item.path, 'Ledger path', 128),
      payloadBase64: bounded(item.payloadBase64, 'Ledger NEAR payload'),
      expectedPublicKey: bounded(item.expectedPublicKey, 'Ledger NEAR key', 128)
    }
  }
  if (item.kind === 'dash-psbt' || item.kind === 'dash-message') {
    const field = item.kind === 'dash-psbt' ? 'psbtBase64' : 'message'
    assertExactKeys(
      item,
      item.kind === 'dash-psbt'
        ? ['kind', 'chainId', 'accountPath', 'xpub', 'expectedAddress', field]
        : ['kind', 'chainId', 'accountPath', 'expectedAddress', field],
      [],
      'Ledger Dash request'
    )
    if (item.chainId !== chainId || chainId !== DASH_CHAIN_IDS.mainnet) {
      throw new Error('Dash hardware wallets support mainnet only')
    }
    const accountPath = validateLedgerDashDerivationPath(
      bounded(item.accountPath, 'Ledger Dash account path', 128)
    )
    const expectedAddress = bounded(item.expectedAddress, 'Ledger Dash address', 128)
    if (item.kind === 'dash-message') {
      return {
        kind: item.kind,
        chainId,
        accountPath,
        expectedAddress,
        message: readBoundedString(item.message, 'Ledger Dash message', 1_500_000)
      }
    }
    return {
      kind: item.kind,
      chainId,
      accountPath,
      xpub: bounded(item.xpub, 'Ledger Dash xpub', 256),
      expectedAddress,
      psbtBase64: bounded(item.psbtBase64, 'Ledger Dash PSBT')
    }
  }
  if (
    item.kind === 'starknet-invoke' ||
    item.kind === 'starknet-deploy-account' ||
    item.kind === 'starknet-typed-data'
  ) {
    const common = [
      'kind',
      'chainId',
      'derivationPath',
      'publicKey',
      'address',
      'classHash',
      'blindSigning'
    ]
    const extra =
      item.kind === 'starknet-typed-data' ? ['messageHash'] : ['transactionHash', 'transaction']
    assertExactKeys(item, [...common, ...extra], [], 'Ledger Starknet request')
    if (chainId !== 'starknet:SN_MAIN' && chainId !== 'starknet:SN_SEPOLIA') {
      throw new Error('Ledger Starknet chain does not match request')
    }
    if (item.chainId !== chainId) throw new Error('Ledger Starknet chain does not match request')
    const starknetChainId: LedgerStarknetChainId =
      chainId === 'starknet:SN_MAIN' ? 'starknet:SN_MAIN' : 'starknet:SN_SEPOLIA'
    if (typeof item.blindSigning !== 'boolean') {
      throw new Error('Invalid Ledger Starknet blind-signing flag')
    }
    const derivationPath = validateLedgerStarknetDerivationPath(
      bounded(item.derivationPath, 'Ledger Starknet path', 128)
    )
    const publicKey = starknetFelt(item.publicKey, 'public key')
    const address = starknetFelt(item.address, 'address')
    const classHash = starknetFelt(item.classHash, 'class hash')
    const binding = {
      chainId: starknetChainId,
      derivationPath,
      publicKey,
      address,
      classHash,
      blindSigning: item.blindSigning
    }
    if (item.kind === 'starknet-typed-data') {
      return {
        kind: 'starknet-typed-data',
        ...binding,
        messageHash: starknetFelt(item.messageHash, 'message hash')
      }
    }
    const transaction = readRecord(item.transaction, 'Ledger Starknet transaction')
    if (JSON.stringify(transaction).length > 200_000) {
      throw new Error('Ledger Starknet transaction is too large')
    }
    const transactionHash = starknetFelt(item.transactionHash, 'transaction hash')
    if (item.kind === 'starknet-invoke') {
      return { kind: 'starknet-invoke', ...binding, transactionHash, transaction }
    }
    return { kind: 'starknet-deploy-account', ...binding, transactionHash, transaction }
  }
  throw new Error('Unsupported Ledger signing request')
}

function starknetFelt(value: unknown, label: string): string {
  const felt = bounded(value, `Ledger Starknet ${label}`, 66)
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(felt)) throw new Error(`Invalid Ledger Starknet ${label}`)
  return felt
}

const summarySchema: Readonly<Record<LedgerDeviceSigningRequest['kind'], string>> = {
  transaction: 'evm.transaction.v1',
  'personal-sign': 'evm.personal-message.v1',
  'typed-data': 'evm.typed-data.v1',
  psbt: 'bitcoin.psbt.v1',
  'bip322-simple': 'bitcoin.bip322-message.v1',
  'solana-transaction': 'solana.transaction.v1',
  'near-transaction': 'near.transaction.v1',
  'near-nep413-message': 'near.nep413-message.v1',
  'dash-psbt': 'dash.psbt.v1',
  'dash-message': 'dash.message.v1',
  'starknet-invoke': 'starknet.invoke.v1',
  'starknet-deploy-account': 'starknet.deploy-account.v1',
  'starknet-typed-data': 'starknet.typed-data.v1'
}

export function parseLedgerPendingSigning(value: unknown, now = Date.now()): LedgerPendingSigning {
  const item = readRecord(value, 'Ledger pending signing')
  assertExactKeys(
    item,
    [
      'requestId',
      'request',
      'scope',
      'payloadFingerprint',
      'expiresAt',
      'summary',
      'requestDigest'
    ],
    ['origin', 'tabId'],
    'Ledger pending signing'
  )
  const requestId = bounded(item.requestId, 'Ledger request ID', 128)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))
    throw new Error('Invalid Ledger request ID')
  const scope = readRecord(item.scope, 'Ledger signing scope')
  assertExactKeys(scope, ['keyDomainId', 'accountId', 'chainId'], [], 'Ledger signing scope')
  const chainId = parseChainId(bounded(scope.chainId, 'Ledger chain ID', 64)).id
  const parsedRequest = request(item.request, chainId)
  const fingerprint = readRecord(item.payloadFingerprint, 'Ledger payload fingerprint')
  assertExactKeys(fingerprint, ['algorithm', 'digestHex'], [], 'Ledger payload fingerprint')
  if (
    fingerprint.algorithm !== 'sha256' ||
    typeof fingerprint.digestHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fingerprint.digestHex)
  )
    throw new Error('Invalid Ledger payload fingerprint')
  const requestDigest = bounded(item.requestDigest, 'Ledger request digest', 64)
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) throw new Error('Invalid Ledger request digest')
  const expiresAt = readSafeInteger(item.expiresAt, 'Ledger request expiry')
  if (expiresAt <= now || expiresAt > now + 10 * 60_000)
    throw new Error('Ledger request expired or has invalid expiry')
  const summary = readRecord(item.summary, 'Ledger signing summary')
  if (summary.schema !== summarySchema[parsedRequest.kind])
    throw new Error('Ledger signing summary does not match request')
  const parsedSummary = parseSigningSummary(summary, {
    chainId,
    family:
      parsedRequest.kind === 'transaction' ||
      parsedRequest.kind === 'personal-sign' ||
      parsedRequest.kind === 'typed-data'
        ? 'evm'
        : parsedRequest.kind === 'psbt' || parsedRequest.kind === 'bip322-simple'
          ? 'bitcoin'
          : parsedRequest.kind === 'solana-transaction'
            ? 'solana'
            : parsedRequest.kind === 'dash-psbt' || parsedRequest.kind === 'dash-message'
              ? 'dash'
              : parsedRequest.kind === 'starknet-invoke' ||
                  parsedRequest.kind === 'starknet-deploy-account' ||
                  parsedRequest.kind === 'starknet-typed-data'
                ? 'starknet'
                : 'near',
    operation:
      parsedRequest.kind === 'personal-sign' ||
      parsedRequest.kind === 'typed-data' ||
      parsedRequest.kind === 'bip322-simple' ||
      parsedRequest.kind === 'near-nep413-message' ||
      parsedRequest.kind === 'dash-message' ||
      parsedRequest.kind === 'starknet-typed-data'
        ? 'message'
        : 'transaction'
  })
  const origin = item.origin === undefined ? undefined : bounded(item.origin, 'Ledger origin', 2048)
  if (origin !== undefined) {
    try {
      new URL(origin)
    } catch {
      throw new Error('Invalid Ledger origin')
    }
  }
  const tabId =
    item.tabId === undefined ? undefined : readSafeInteger(item.tabId, 'Ledger signing tab ID')
  return Object.freeze({
    requestId,
    request: parsedRequest,
    scope: Object.freeze({
      keyDomainId: parseKeyDomainId(scope.keyDomainId),
      accountId: parseAccountId(scope.accountId),
      chainId
    }),
    payloadFingerprint: Object.freeze({ algorithm: 'sha256', digestHex: fingerprint.digestHex }),
    expiresAt,
    ...(origin === undefined ? {} : { origin }),
    summary: parsedSummary,
    requestDigest,
    ...(tabId === undefined ? {} : { tabId })
  })
}
