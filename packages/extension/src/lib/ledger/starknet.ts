import {
  Apdu,
  type DeviceManagementKit,
  type DeviceSessionId
} from '@ledgerhq/device-management-kit'
import {
  ARGENT_V04_CLASS_HASH,
  ARGENT_V05_CLASS_HASH,
  LEDGER_STARKNET_APP_NAME,
  assertLedgerStarknetDeviceSupported,
  exchangeStarknetApdus,
  normalizeStarknetLedgerFelt,
  parseStarknetLedgerSignature,
  planStarknetDeployAccountApdus,
  planStarknetInvokeApdus,
  planStarknetSignHashApdus,
  readLedgerStarknetPublicKey,
  readLedgerStarknetVersion,
  starknetFeltBytes,
  type StarknetApdu,
  type StarknetFeeWords,
  type StarknetLedgerCall
} from './starknet-model'
import {
  getLedgerDeviceName,
  openLedgerApp,
  type LedgerSessionOptions,
  withLedgerSession
} from './device'
import type {
  LedgerStarknetSigningRequest,
  LedgerStarknetSigningResponse
} from '@/core/keyring/protocol/ledger-signing'

interface StarknetApduResponse {
  readonly data: Uint8Array
  readonly status: number
}

export function starknetInvokeSigningApdus(
  request: Extract<LedgerStarknetSigningRequest, { kind: 'starknet-invoke' }>
): readonly StarknetApdu[] {
  return planStarknetInvokeApdus({
    path: request.derivationPath,
    senderAddress: request.address,
    chainIdFelt: chainFelt(request.chainId),
    nonce: feltField(request.transaction, 'nonce'),
    dataAvailabilityMode: dataAvailabilityMode(request.transaction),
    fees: feeWords(request.transaction),
    calls: callsFromTransaction(request.transaction)
  })
}

export function starknetDeploySigningApdus(
  request: Extract<LedgerStarknetSigningRequest, { kind: 'starknet-deploy-account' }>
): readonly StarknetApdu[] {
  const transaction = request.transaction
  return planStarknetDeployAccountApdus({
    path: request.derivationPath,
    contractAddress: request.address,
    chainIdFelt: chainFelt(request.chainId),
    nonce: feltField(transaction, 'nonce'),
    dataAvailabilityMode: dataAvailabilityMode(transaction),
    classHash: request.classHash,
    salt: feltField(transaction, 'salt', request.publicKey),
    fees: feeWords(transaction),
    constructorCalldata: stringList(
      transaction.constructorCalldata ?? transaction.constructor_calldata
    )
  })
}

export async function signLedgerStarknetRequest(
  request: LedgerStarknetSigningRequest,
  options: LedgerSessionOptions
): Promise<LedgerStarknetSigningResponse> {
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    assertLedgerStarknetDeviceSupported(device.deviceModel.model)
    const send = (apdu: StarknetApdu) => sendStarknetApdu(dmk, sessionId, apdu, options.signal)
    await readLedgerStarknetVersion(send)
    await openLedgerApp(
      dmk,
      sessionId,
      LEDGER_STARKNET_APP_NAME,
      options.signal,
      options.onInteraction
    )
    const publicKey = await readLedgerStarknetPublicKey(request.derivationPath, false, send)
    if (normalizeStarknetLedgerFelt(publicKey) !== normalizeStarknetLedgerFelt(request.publicKey)) {
      throw new Error('Ledger Starknet public key does not match')
    }
    const apdus =
      request.kind === 'starknet-typed-data'
        ? planStarknetSignHashApdus(request.derivationPath, request.messageHash)
        : request.kind === 'starknet-invoke'
          ? starknetInvokeSigningApdus(request)
          : starknetDeploySigningApdus(request)
    const response = await exchangeStarknetApdus(apdus, send)
    const expected =
      request.kind === 'starknet-typed-data'
        ? undefined
        : starknetFeltBytes(request.transactionHash)
    const parsed = parseStarknetLedgerSignature(response, expected)
    const signature = [parsed.r, parsed.s] as const
    return Object.freeze({
      kind: request.kind,
      publicKey,
      signature
    })
  })
}

export interface LedgerStarknetDiscoveredAccount {
  readonly path: string
  readonly publicKey: string
  readonly address: string
  readonly classHash: string
  readonly accountType: 'argent'
  readonly appVersion: string
  readonly deviceModel: string
  readonly deviceName: string
  readonly deployed: boolean
  readonly selectable: boolean
  readonly detail: string
}

export async function discoverLedgerStarknetAccounts(
  paths: readonly string[],
  options: LedgerSessionOptions & {
    readonly computeAddress: (
      publicKey: string
    ) => Promise<{ readonly address: string; readonly classHash: string }>
    readonly classHashAt: (address: string) => Promise<string | null>
  }
): Promise<readonly LedgerStarknetDiscoveredAccount[]> {
  if (paths.length === 0) return []
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    assertLedgerStarknetDeviceSupported(device.deviceModel.model)
    const send = (apdu: StarknetApdu) => sendStarknetApdu(dmk, sessionId, apdu, options.signal)
    const appVersion = await readLedgerStarknetVersion(send)
    await openLedgerApp(
      dmk,
      sessionId,
      LEDGER_STARKNET_APP_NAME,
      options.signal,
      options.onInteraction
    )
    const accounts: LedgerStarknetDiscoveredAccount[] = []
    for (const path of paths) {
      options.signal?.throwIfAborted()
      const publicKey = await readLedgerStarknetPublicKey(path, false, send)
      const computed = await options.computeAddress(publicKey)
      if (normalize(computed.classHash) !== normalize(ARGENT_V04_CLASS_HASH)) {
        throw new Error('Starknet compute-address did not return Argent v0.4')
      }
      const onChain = await options.classHashAt(computed.address)
      const deployed = onChain !== null
      const allowed =
        !deployed ||
        normalize(onChain) === normalize(ARGENT_V04_CLASS_HASH) ||
        normalize(onChain) === normalize(ARGENT_V05_CLASS_HASH)
      accounts.push(
        Object.freeze({
          path,
          publicKey,
          address: computed.address,
          classHash: deployed ? onChain : computed.classHash,
          accountType: 'argent',
          appVersion,
          deviceModel: device.deviceModel.model,
          deviceName: getLedgerDeviceName(device.deviceModel.model, device.name),
          deployed,
          selectable: allowed,
          detail: deployed
            ? allowed
              ? `Deployed ${shortHash(onChain)}`
              : `Class ${shortHash(onChain)} cannot be added`
            : 'Undeployed Argent v0.4'
        })
      )
    }
    return accounts
  })
}

async function sendStarknetApdu(
  dmk: DeviceManagementKit,
  sessionId: DeviceSessionId,
  command: StarknetApdu,
  signal?: AbortSignal
): Promise<StarknetApduResponse> {
  signal?.throwIfAborted()
  const response = await dmk.sendApdu({
    sessionId,
    apdu: new Apdu(command.cla, command.ins, command.p1, command.p2, command.data).getRawApdu()
  })
  signal?.throwIfAborted()
  const status = (response.statusCode[0] << 8) | response.statusCode[1]
  return { data: response.data, status }
}

function chainFelt(chainId: 'starknet:SN_MAIN' | 'starknet:SN_SEPOLIA'): string {
  return chainId === 'starknet:SN_MAIN' ? '0x534e5f4d41494e' : '0x534e5f5345504f4c4941'
}

function feeWords(transaction: Readonly<Record<string, unknown>>): StarknetFeeWords {
  const bounds = record(
    transaction.resourceBounds ?? transaction.resource_bounds,
    'resource bounds'
  )
  return {
    tip: decimal(transaction.tip ?? '0', 'tip'),
    l1Gas: bound(bounds, 'l1Gas', 'l1_gas'),
    l2Gas: bound(bounds, 'l2Gas', 'l2_gas'),
    l1DataGas: bound(bounds, 'l1DataGas', 'l1_data_gas')
  }
}

function bound(
  bounds: Readonly<Record<string, unknown>>,
  camel: string,
  snake: string
): { readonly maxAmount: bigint; readonly maxPricePerUnit: bigint } {
  const value = record(bounds[camel] ?? bounds[snake] ?? zeroBound(), camel)
  return {
    maxAmount: decimal(value.maxAmount ?? value.max_amount ?? '0', `${camel} amount`),
    maxPricePerUnit: decimal(
      value.maxPricePerUnit ?? value.max_price_per_unit ?? '0',
      `${camel} price`
    )
  }
}

function zeroBound(): Readonly<Record<string, unknown>> {
  return { maxAmount: '0', maxPricePerUnit: '0' }
}

function callsFromTransaction(
  transaction: Readonly<Record<string, unknown>>
): readonly StarknetLedgerCall[] {
  const calls = transaction.calls
  if (!Array.isArray(calls)) throw new Error('Ledger Starknet transaction has no calls')
  return calls.map(item => {
    const call = record(item, 'call')
    const selector = call.selector ?? call.entry_point ?? call.entrypoint
    if (typeof selector !== 'string' || !selector.startsWith('0x')) {
      throw new Error('Ledger Starknet call selector is missing')
    }
    const to = call.to ?? call.contract_address ?? call.contractAddress
    if (typeof to !== 'string') throw new Error('Ledger Starknet call target is missing')
    return { to, selector, calldata: stringList(call.calldata) }
  })
}

function dataAvailabilityMode(transaction: Readonly<Record<string, unknown>>): string {
  const packed = transaction.dataAvailabilityMode ?? transaction.data_availability_mode
  if (typeof packed === 'string') return packed
  const nonce = modeBit(
    transaction.nonceDataAvailabilityMode ?? transaction.nonce_data_availability_mode
  )
  const fee = modeBit(transaction.feeDataAvailabilityMode ?? transaction.fee_data_availability_mode)
  // Spec packing: nonce mode in the low 32 bits, fee mode shifted by 32. L1 is 0 and L2 is 1.
  return `0x${(nonce + (fee << 32)).toString(16)}`
}

function modeBit(value: unknown): number {
  if (value === undefined || value === 0 || value === '0' || value === '0x0') return 0
  if (typeof value === 'string' && value.toLowerCase() === 'l1') return 0
  if (value === 1 || value === '1' || value === '0x1') return 1
  if (typeof value === 'string' && value.toLowerCase() === 'l2') return 1
  throw new Error('Invalid Starknet data availability mode')
}

function feltField(
  transaction: Readonly<Record<string, unknown>>,
  key: string,
  fallback?: string
): string {
  const value = transaction[key] ?? fallback
  if (typeof value !== 'string') throw new Error(`Ledger Starknet ${key} is missing`)
  return value
}

function stringList(value: unknown): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('Ledger Starknet calldata is invalid')
  }
  return value
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Ledger Starknet ${label} is invalid`)
  }
  return value as Readonly<Record<string, unknown>>
}

function decimal(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) {
    throw new Error(`Invalid Starknet ${label}`)
  }
  return BigInt(value)
}

function normalize(value: string): string {
  return `0x${value.replace(/^0x0*/, '') || '0'}`.toLowerCase()
}

function shortHash(value: string): string {
  const hex = value.startsWith('0x') ? value : `0x${value}`
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`
}
