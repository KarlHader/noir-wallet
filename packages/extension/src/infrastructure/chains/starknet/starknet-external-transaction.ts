import {
  assertStarknetFelt,
  feltFromBigint,
  feltToBigint,
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_EXECUTION_VERSION,
  STARKNET_QUERY_VERSION,
  starknetSelectorFromName,
  type StarknetResourceBounds
} from './starknet-primitives'

/**
 * Query-version transaction for starknet_estimateFee.
 * prepare owns the execution hash. Do not broadcast this JSON or pass it to assemble.
 */

export type StarknetExternalImplementation = 'argent_v04' | 'open_zeppelin'

const DECIMAL = /^(0|[1-9][0-9]*)$/

export function starknetExternalImplementation(classHash: string): StarknetExternalImplementation {
  return sameFelt(classHash, STARKNET_ARGENT_V04_CLASS_HASH) ? 'argent_v04' : 'open_zeppelin'
}

export function starknetInvokeExternalRequest(input: {
  readonly chainId: string
  readonly publicKey: string
  readonly accountAddress: string
  readonly classHash: string
  readonly calls: unknown
  readonly nonce: string
  readonly resourceBounds: unknown
}): Readonly<Record<string, unknown>> {
  const implementation = starknetExternalImplementation(input.classHash)
  return Object.freeze({
    chainId: readChainId(input.chainId),
    publicKey: feltHex(input.publicKey, 'public key'),
    accountAddress: feltHex(input.accountAddress, 'account address'),
    classHash: feltHex(input.classHash, 'class hash'),
    implementation,
    calls: readRequestCalls(input.calls),
    nonce: feltHex(input.nonce, 'nonce'),
    resourceBounds: readBounds(input.resourceBounds),
    paymasterData: Object.freeze([]),
    accountDeploymentData: Object.freeze([])
  })
}

export function starknetDeployExternalRequest(input: {
  readonly chainId: string
  readonly publicKey: string
  readonly accountAddress: string
  readonly classHash: string
  readonly nonce: string
  readonly resourceBounds: unknown
}): Readonly<Record<string, unknown>> {
  const implementation = starknetExternalImplementation(input.classHash)
  return Object.freeze({
    chainId: readChainId(input.chainId),
    publicKey: feltHex(input.publicKey, 'public key'),
    accountAddress: feltHex(input.accountAddress, 'account address'),
    classHash: feltHex(input.classHash, 'class hash'),
    implementation,
    nonce: feltHex(input.nonce, 'nonce'),
    resourceBounds: readBounds(input.resourceBounds),
    paymasterData: Object.freeze([])
  })
}

export function starknetExternalAssembleRequest(
  request: Readonly<Record<string, unknown>>,
  signature: readonly [string, string]
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...request,
    signature: Object.freeze([
      feltHex(signature[0], 'signature r'),
      feltHex(signature[1], 'signature s')
    ])
  })
}

export interface StarknetExternalPreparation {
  readonly signingHash: string
  readonly summary: Readonly<Record<string, unknown>>
}

export function parseStarknetExternalPreparation(value: unknown): StarknetExternalPreparation {
  const record = readRecord(value, 'Starknet prepare result')
  if (!isRecord(record.account)) throw new Error('Starknet prepare result is invalid')
  const summary = readRecord(record.summary, 'Starknet prepare summary')
  return {
    signingHash: feltHex(record.signingHash, 'signing hash'),
    summary
  }
}

export function readAssembledStarknetTransaction(
  value: unknown,
  kind: 'invoke' | 'deploy',
  signingHash: string
): Readonly<Record<string, unknown>> {
  const record = readRecord(value, 'Starknet assembled transaction')
  const transactionHash = feltHex(record.transactionHash, 'transaction hash')
  if (transactionHash !== feltHex(signingHash, 'signing hash')) {
    throw new Error('Starknet signature does not match the review')
  }
  const key = kind === 'invoke' ? 'invokeTransaction' : 'deployAccountTransaction'
  const transaction = readRecord(record[key], 'Starknet transaction')
  if (transaction.version !== STARKNET_EXECUTION_VERSION) {
    throw new Error('Starknet signature does not match the review')
  }
  return transaction
}

/** Summary projected from the request so fee estimation can run before prepare. */
export function starknetInvokeProbeSummary(
  request: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const calls = readRequestCalls(request.calls)
  return {
    senderAddress: feltHex(request.accountAddress, 'account address'),
    nonce: feltHex(request.nonce, 'nonce'),
    tip: '0',
    resourceBounds: readBounds(request.resourceBounds),
    calls: calls.map(call => ({
      to: call.to,
      selector: call.selector,
      entrypoint: null,
      calldata: [...call.calldata]
    })),
    nonceDataAvailabilityMode: 'l1',
    feeDataAvailabilityMode: 'l1'
  }
}

/** Summary projected from the request so fee estimation can run before prepare. */
export function starknetDeployProbeSummary(
  request: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const publicKey = feltHex(request.publicKey, 'public key')
  const implementation = readImplementation(request.implementation)
  return {
    contractAddress: feltHex(request.accountAddress, 'account address'),
    classHash: feltHex(request.classHash, 'class hash'),
    salt: publicKey,
    constructorCalldata: expectedConstructor(implementation, publicKey),
    nonce: feltHex(request.nonce, 'nonce'),
    tip: '0',
    resourceBounds: readBounds(request.resourceBounds),
    nonceDataAvailabilityMode: 'l1',
    feeDataAvailabilityMode: 'l1'
  }
}

export function starknetInvokeFeeEstimateTransaction(
  request: Readonly<Record<string, unknown>>,
  summary: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  assertInvokeSummary(request, summary)
  const calls = readSummaryCalls(summary)
  return {
    type: 'INVOKE',
    version: STARKNET_QUERY_VERSION,
    sender_address: feltHex(summary.senderAddress, 'sender address'),
    calldata: encodeOzCalls(calls),
    signature: [],
    nonce: feltHex(summary.nonce, 'nonce'),
    resource_bounds: hexBounds(readBounds(summary.resourceBounds)),
    tip: decimalToHex(readDecimal(summary.tip, 'tip'), 'tip'),
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: queryDataAvailabilityMode(summary.nonceDataAvailabilityMode),
    fee_data_availability_mode: queryDataAvailabilityMode(summary.feeDataAvailabilityMode)
  }
}

export function starknetDeployFeeEstimateTransaction(
  request: Readonly<Record<string, unknown>>,
  summary: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  assertDeploySummary(request, summary)
  const constructor = readFeltList(summary.constructorCalldata, 'constructor calldata')
  return {
    type: 'DEPLOY_ACCOUNT',
    version: STARKNET_QUERY_VERSION,
    class_hash: feltHex(summary.classHash, 'class hash'),
    contract_address_salt: feltHex(summary.salt, 'salt'),
    constructor_calldata: constructor.map(felt => feltHex(felt, 'constructor calldata')),
    nonce: feltHex(summary.nonce, 'nonce'),
    signature: [],
    resource_bounds: hexBounds(readBounds(summary.resourceBounds)),
    tip: decimalToHex(readDecimal(summary.tip, 'tip'), 'tip'),
    paymaster_data: [],
    nonce_data_availability_mode: queryDataAvailabilityMode(summary.nonceDataAvailabilityMode),
    fee_data_availability_mode: queryDataAvailabilityMode(summary.feeDataAvailabilityMode)
  }
}

export function assertStarknetInvokeSummary(
  request: Readonly<Record<string, unknown>>,
  summary: Readonly<Record<string, unknown>>
): void {
  assertInvokeSummary(request, summary)
}

export function assertStarknetDeploySummary(
  request: Readonly<Record<string, unknown>>,
  summary: Readonly<Record<string, unknown>>
): void {
  assertDeploySummary(request, summary)
}

function assertInvokeSummary(
  request: Readonly<Record<string, unknown>>,
  summary: Readonly<Record<string, unknown>>
): void {
  assertSameFelt(summary.senderAddress, request.accountAddress, 'sender address')
  assertSameFelt(summary.nonce, request.nonce, 'nonce')
  assertSameDecimal(summary.tip, '0', 'tip')
  assertSameBounds(summary.resourceBounds, request.resourceBounds)
  assertSameMode(summary.nonceDataAvailabilityMode, 'l1', 'nonce data availability mode')
  assertSameMode(summary.feeDataAvailabilityMode, 'l1', 'fee data availability mode')
  const actual = readSummaryCalls(summary)
  const expected = readRequestCalls(request.calls)
  if (actual.length !== expected.length) {
    throw new Error('Starknet prepare summary calls do not match the request')
  }
  actual.forEach((call, index) => {
    const requested = expected[index]
    if (!requested) throw new Error('Starknet prepare summary calls do not match the request')
    assertSameFelt(call.to, requested.to, 'call target')
    assertSameFelt(call.selector, requested.selector, 'call selector')
    if (call.calldata.length !== requested.calldata.length) {
      throw new Error('Starknet prepare summary calldata does not match the request')
    }
    call.calldata.forEach((felt, feltIndex) => {
      assertSameFelt(felt, requested.calldata[feltIndex], 'calldata')
    })
  })
}

function assertDeploySummary(
  request: Readonly<Record<string, unknown>>,
  summary: Readonly<Record<string, unknown>>
): void {
  const publicKey = feltHex(request.publicKey, 'public key')
  const implementation = readImplementation(request.implementation)
  assertSameFelt(summary.contractAddress, request.accountAddress, 'contract address')
  assertSameFelt(summary.classHash, request.classHash, 'class hash')
  assertSameFelt(summary.salt, publicKey, 'salt')
  assertSameFelt(summary.nonce, request.nonce, 'nonce')
  assertSameDecimal(summary.tip, '0', 'tip')
  assertSameBounds(summary.resourceBounds, request.resourceBounds)
  assertSameMode(summary.nonceDataAvailabilityMode, 'l1', 'nonce data availability mode')
  assertSameMode(summary.feeDataAvailabilityMode, 'l1', 'fee data availability mode')
  const constructor = readFeltList(summary.constructorCalldata, 'constructor calldata')
  const expected = expectedConstructor(implementation, publicKey)
  if (constructor.length !== expected.length) {
    throw new Error('Starknet prepare summary constructor does not match the request')
  }
  constructor.forEach((felt, index) =>
    assertSameFelt(felt, expected[index], 'constructor calldata')
  )
}

function expectedConstructor(
  implementation: StarknetExternalImplementation,
  publicKey: string
): readonly string[] {
  return implementation === 'argent_v04' ? ['0x0', publicKey, '0x1'] : [publicKey]
}

interface EncodedCall {
  readonly to: string
  readonly selector: string
  readonly calldata: readonly string[]
}

function encodeOzCalls(calls: readonly EncodedCall[]): readonly string[] {
  const encoded = [feltFromBigint(BigInt(calls.length))]
  for (const call of calls) {
    encoded.push(call.to, call.selector, feltFromBigint(BigInt(call.calldata.length)))
    encoded.push(...call.calldata)
  }
  return Object.freeze(encoded)
}

function readRequestCalls(value: unknown): readonly EncodedCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Starknet invoke requires a call')
  }
  return Object.freeze(
    value.map(item => {
      const call = readRecord(item, 'Starknet call')
      const selector =
        typeof call.selector === 'string'
          ? call.selector
          : typeof call.entrypoint === 'string'
            ? starknetSelectorFromName(call.entrypoint)
            : undefined
      if (selector === undefined) throw new Error('Starknet call selector is missing')
      if (typeof call.selector === 'string' && typeof call.entrypoint === 'string') {
        throw new Error('Starknet call must contain exactly one of entrypoint or selector')
      }
      return Object.freeze({
        to: feltHex(call.to, 'call target'),
        selector: feltHex(selector, 'call selector'),
        calldata: Object.freeze(readFeltList(call.calldata ?? [], 'calldata'))
      })
    })
  )
}

function readSummaryCalls(summary: Readonly<Record<string, unknown>>): readonly EncodedCall[] {
  const calls = summary.calls
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('Starknet prepare summary calls are invalid')
  }
  return calls.map(item => {
    const call = readRecord(item, 'Starknet summary call')
    if (call.entrypoint !== null)
      throw new Error('Starknet prepare summary entrypoint must be null')
    return {
      to: feltHex(call.to, 'call target'),
      selector: feltHex(call.selector, 'call selector'),
      calldata: readFeltList(call.calldata, 'calldata')
    }
  })
}

function hexBounds(bounds: StarknetResourceBounds): Readonly<Record<string, unknown>> {
  const bound = (value: StarknetResourceBounds['l1Gas']) => ({
    max_amount: decimalToHex(value.maxAmount, 'resource bound'),
    max_price_per_unit: decimalToHex(value.maxPricePerUnit, 'resource bound')
  })
  return {
    l1_gas: bound(bounds.l1Gas),
    l2_gas: bound(bounds.l2Gas),
    l1_data_gas: bound(bounds.l1DataGas)
  }
}

function readBounds(value: unknown): StarknetResourceBounds {
  const record = readRecord(value, 'Starknet resource bounds')
  const readBound = (key: 'l1Gas' | 'l2Gas' | 'l1DataGas') => {
    const bound = readRecord(record[key], key)
    return {
      maxAmount: readDecimal(bound.maxAmount, `${key} max amount`),
      maxPricePerUnit: readDecimal(bound.maxPricePerUnit, `${key} max price`)
    }
  }
  return {
    l1Gas: readBound('l1Gas'),
    l2Gas: readBound('l2Gas'),
    l1DataGas: readBound('l1DataGas')
  }
}

function assertSameBounds(actual: unknown, expected: unknown): void {
  const left = readBounds(actual)
  const right = readBounds(expected)
  ;(['l1Gas', 'l2Gas', 'l1DataGas'] as const).forEach(name => {
    assertSameDecimal(left[name].maxAmount, right[name].maxAmount, `${name} max amount`)
    assertSameDecimal(left[name].maxPricePerUnit, right[name].maxPricePerUnit, `${name} max price`)
  })
}

function queryDataAvailabilityMode(value: unknown): 'L1' | 'L2' {
  if (value === 'l1') return 'L1'
  if (value === 'l2') return 'L2'
  throw new Error('Starknet data availability mode is invalid')
}

function assertSameMode(actual: unknown, expected: 'l1' | 'l2', label: string): void {
  if (actual !== expected)
    throw new Error(`Starknet prepare summary ${label} does not match the request`)
}

function readImplementation(value: unknown): StarknetExternalImplementation {
  if (value === 'argent_v04' || value === 'open_zeppelin') return value
  throw new Error('Starknet implementation is invalid')
}

function readChainId(value: string): 'starknet:SN_MAIN' | 'starknet:SN_SEPOLIA' {
  if (value === 'starknet:SN_MAIN' || value === 'starknet:SN_SEPOLIA') return value
  throw new Error('Starknet network changed')
}

function readFeltList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Starknet ${label} is invalid`)
  return value.map(item => feltHex(item, label))
}

function readDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error(`Starknet ${label} is invalid`)
  }
  return value
}

function assertSameDecimal(actual: unknown, expected: string, label: string): void {
  if (readDecimal(actual, label) !== expected) {
    throw new Error(`Starknet prepare summary ${label} does not match the request`)
  }
}

function assertSameFelt(actual: unknown, expected: unknown, label: string): void {
  if (!sameFelt(feltHex(actual, label), feltHex(expected, label))) {
    throw new Error(`Starknet prepare summary ${label} does not match the request`)
  }
}

function decimalToHex(value: string, label: string): string {
  return feltFromBigint(BigInt(readDecimal(value, label)))
}

function feltHex(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Starknet ${label} is invalid`)
  const felt = assertStarknetFelt(value.toLowerCase(), label)
  return feltFromBigint(feltToBigint(felt))
}

function sameFelt(left: string, right: string): boolean {
  try {
    return (
      feltToBigint(assertStarknetFelt(left.toLowerCase(), 'felt')) ===
      feltToBigint(assertStarknetFelt(right.toLowerCase(), 'felt'))
    )
  } catch {
    return false
  }
}

function readRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${label} is invalid`)
  return value
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
