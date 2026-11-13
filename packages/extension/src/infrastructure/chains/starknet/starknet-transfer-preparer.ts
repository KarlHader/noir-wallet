import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'

import { readStarknetAccountDeployment } from './starknet-account-state'
import { readStarknetTokenBalance } from './starknet-balance-reader'
import {
  assertStarknetInvokeSummary,
  assertStarknetDeploySummary,
  parseStarknetExternalPreparation,
  starknetDeployExternalRequest,
  starknetDeployFeeEstimateTransaction,
  starknetDeployProbeSummary,
  starknetInvokeExternalRequest,
  starknetInvokeFeeEstimateTransaction,
  starknetInvokeProbeSummary
} from './starknet-external-transaction'
import {
  encodeStarknetU256,
  feltFromBigint,
  inflateStarknetFeeEstimate,
  resolveStarknetMaxAmount,
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_OZ_CLASS_HASH,
  STARKNET_TRANSFER_SELECTOR,
  starknetBoundsMaxFee,
  type StarknetFeeEstimate,
  type StarknetResourceBounds
} from './starknet-primitives'
import type { StarknetReadRpc } from './starknet-rpc-types'

const PLACEHOLDER_BOUNDS: StarknetResourceBounds = {
  l1Gas: { maxAmount: '1000000', maxPricePerUnit: '1000000000000000' },
  l2Gas: { maxAmount: '5000000', maxPricePerUnit: '1000000000000000' },
  l1DataGas: { maxAmount: '1000000', maxPricePerUnit: '1000000000000000' }
}

export interface StarknetCall {
  readonly to: string
  readonly selector?: string
  readonly entrypoint?: string
  readonly calldata: readonly string[]
}

export interface StarknetAccountRef {
  readonly chainId: string
  readonly address: string
  readonly publicKey: string
  readonly classHash: string
}

export interface StarknetUnsignedBuild {
  readonly transactionHash: string
  /** Prepare summary. Ledger reviews this object; it is not the broadcast transaction. */
  readonly transaction: Readonly<Record<string, unknown>>
  readonly query: boolean
}

export interface StarknetExternalBuilder {
  prepareInvoke(payload: Readonly<Record<string, unknown>>): Promise<unknown>
  prepareDeploy(payload: Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface StarknetPreparedFee {
  readonly nonce: string
  readonly resourceBounds: StarknetResourceBounds
  readonly maxFee: bigint
  readonly estimate: StarknetFeeEstimate
  readonly unsigned: StarknetUnsignedBuild
}

export interface StarknetPreparedTransfer {
  readonly account: StarknetAccountRef
  readonly assetReference: string
  readonly feeToken: boolean
  readonly recipient: string
  readonly amount: bigint
  readonly deployed: boolean
  readonly deploy: StarknetPreparedFee | null
  readonly invoke: StarknetPreparedFee
  readonly maxFee: bigint
}

export function starknetTransferCall(
  token: string,
  recipient: string,
  amount: bigint
): StarknetCall {
  const [low, high] = encodeStarknetU256(amount)
  return {
    to: normalizeStarknetFelt(token),
    selector: STARKNET_TRANSFER_SELECTOR,
    calldata: [normalizeStarknetFelt(recipient), low, high]
  }
}

export async function quoteStarknetInvoke(input: {
  readonly rpc: Pick<StarknetReadRpc, 'estimateFees' | 'getNonce' | 'getClassHashAt'>
  readonly builder: StarknetExternalBuilder
  readonly account: StarknetAccountRef
  readonly calls: readonly StarknetCall[]
  readonly nonce?: bigint
  readonly signal?: AbortSignal
}): Promise<StarknetPreparedFee> {
  const nonce =
    input.nonce ??
    (await readStarknetAccountDeployment(input.rpc, input.account.address, input.signal)).nonce
  return quoteInvokeAtNonce(
    input.rpc,
    input.builder,
    input.account,
    input.calls,
    nonce,
    input.signal
  )
}

export class StarknetUndeployedAccountError extends Error {
  constructor() {
    super('Starknet hardware deploy is not enabled')
    this.name = 'StarknetUndeployedAccountError'
  }
}

/**
 * Quotes a dApp invoke for a Ledger account. Deployed accounts are quoted as a
 * single invoke. Undeployed Argent v0.4 accounts are quoted as a deploy (nonce 0)
 * plus an invoke (nonce 1) so the approval flow can sign and broadcast both.
 * Undeployed accounts that cannot be deployed raise a typed error so the dApp
 * handler can reject the request before opening the approval popup.
 */
export async function quoteStarknetDAppInvoke(input: {
  readonly rpc: Pick<StarknetReadRpc, 'estimateFees' | 'getNonce' | 'getClassHashAt'>
  readonly builder: StarknetExternalBuilder
  readonly account: StarknetAccountRef
  readonly calls: readonly StarknetCall[]
  readonly signal?: AbortSignal
}): Promise<{
  readonly deploy: StarknetPreparedFee | null
  readonly invoke: StarknetPreparedFee
}> {
  const deployment = await readStarknetAccountDeployment(
    input.rpc,
    input.account.address,
    input.signal
  )
  if (!deployment.deployed) {
    if (!canDeployStarknetAccount(input.account.classHash)) {
      throw new StarknetUndeployedAccountError()
    }
    return quoteUndeployedTransfer(
      input.rpc,
      input.builder,
      input.account,
      input.calls,
      input.signal
    )
  }
  return {
    deploy: null,
    invoke: await quoteInvokeAtNonce(
      input.rpc,
      input.builder,
      input.account,
      input.calls,
      deployment.nonce,
      input.signal
    )
  }
}

export async function prepareStarknetTransfer(input: {
  readonly rpc: Pick<StarknetReadRpc, 'estimateFees' | 'getNonce' | 'getClassHashAt' | 'call'>
  readonly builder: StarknetExternalBuilder
  readonly account: StarknetAccountRef
  readonly tokenReference: string
  readonly feeTokenReference: string
  readonly recipient: string
  readonly amount: bigint
  readonly signal?: AbortSignal
}): Promise<StarknetPreparedTransfer> {
  if (input.amount <= 0n) throw new Error('Starknet transfer amount must be positive')
  const deployment = await readStarknetAccountDeployment(
    input.rpc,
    input.account.address,
    input.signal
  )
  if (
    deployment.deployed &&
    deployment.classHash !== normalizeStarknetFelt(input.account.classHash)
  ) {
    throw new Error('Starknet account class does not match the wallet')
  }
  if (!deployment.deployed && !canDeployStarknetAccount(input.account.classHash)) {
    throw new Error('Starknet hardware deploy is not enabled')
  }
  const call = starknetTransferCall(input.tokenReference, input.recipient, input.amount)
  const quoted = deployment.deployed
    ? {
        deploy: null,
        invoke: await quoteInvokeAtNonce(
          input.rpc,
          input.builder,
          input.account,
          [call],
          deployment.nonce,
          input.signal
        )
      }
    : await quoteUndeployedTransfer(input.rpc, input.builder, input.account, [call], input.signal)
  const invoke = quoted.invoke
  const deploy = quoted.deploy
  const balance = await readStarknetTokenBalance(
    input.rpc,
    input.tokenReference,
    input.account.address,
    input.signal
  )
  const feeBalance =
    normalizeStarknetFelt(input.tokenReference) === normalizeStarknetFelt(input.feeTokenReference)
      ? balance
      : await readStarknetTokenBalance(
          input.rpc,
          input.feeTokenReference,
          input.account.address,
          input.signal
        )
  const maxFee = invoke.maxFee + (deploy?.maxFee ?? 0n)
  const feeToken =
    normalizeStarknetFelt(input.tokenReference) === normalizeStarknetFelt(input.feeTokenReference)
  if (feeToken) {
    if (balance < input.amount + maxFee)
      throw new Error('Starknet balance cannot cover the amount and max fee')
  } else if (feeBalance < maxFee || balance < input.amount) {
    throw new Error('Starknet balance cannot cover the amount and max fee')
  }
  return {
    account: input.account,
    assetReference: normalizeStarknetFelt(input.tokenReference),
    feeToken,
    recipient: normalizeStarknetFelt(input.recipient),
    amount: input.amount,
    deployed: deployment.deployed,
    deploy,
    invoke,
    maxFee
  }
}

export async function quoteStarknetMaximum(input: {
  readonly rpc: Pick<StarknetReadRpc, 'estimateFees' | 'getNonce' | 'getClassHashAt' | 'call'>
  readonly builder: StarknetExternalBuilder
  readonly account: StarknetAccountRef
  readonly tokenReference: string
  readonly feeTokenReference: string
  readonly signal?: AbortSignal
}): Promise<bigint | null> {
  const tokenBalance = await readStarknetTokenBalance(
    input.rpc,
    input.tokenReference,
    input.account.address,
    input.signal
  )
  const feeToken =
    normalizeStarknetFelt(input.tokenReference) === normalizeStarknetFelt(input.feeTokenReference)
  const strkBalance = feeToken
    ? tokenBalance
    : await readStarknetTokenBalance(
        input.rpc,
        input.feeTokenReference,
        input.account.address,
        input.signal
      )
  if (tokenBalance === 0n) return feeToken ? 0n : null
  const probe = await prepareStarknetTransfer({
    rpc: input.rpc,
    builder: input.builder,
    account: input.account,
    tokenReference: input.tokenReference,
    feeTokenReference: input.feeTokenReference,
    recipient: input.account.address,
    amount: 1n,
    signal: input.signal
  }).catch(() => null)
  if (!probe) return feeToken ? 0n : null
  return resolveStarknetMaxAmount({
    tokenBalance,
    strkBalance,
    invokeMaxFee: probe.invoke.maxFee,
    ...(probe.deploy ? { deployMaxFee: probe.deploy.maxFee } : {}),
    feeToken
  })
}

async function quoteInvokeAtNonce(
  rpc: Pick<StarknetReadRpc, 'estimateFees'>,
  builder: StarknetExternalBuilder,
  account: StarknetAccountRef,
  calls: readonly StarknetCall[],
  nonce: bigint,
  signal?: AbortSignal
): Promise<StarknetPreparedFee> {
  const probe = starknetInvokeExternalRequest({
    chainId: account.chainId,
    publicKey: account.publicKey,
    accountAddress: account.address,
    classHash: account.classHash,
    calls,
    nonce: feltFromBigint(nonce),
    resourceBounds: PLACEHOLDER_BOUNDS
  })
  const [estimate] = await rpc.estimateFees(
    [starknetInvokeFeeEstimateTransaction(probe, starknetInvokeProbeSummary(probe))],
    signal
  )
  if (!estimate) throw new Error('Starknet fee estimate is missing')
  const resourceBounds = inflateStarknetFeeEstimate(estimate)
  const unsigned = await prepareInvoke(builder, account, calls, nonce, resourceBounds)
  return {
    nonce: feltFromBigint(nonce),
    resourceBounds,
    maxFee: starknetBoundsMaxFee(resourceBounds),
    estimate,
    unsigned
  }
}

async function quoteUndeployedTransfer(
  rpc: Pick<StarknetReadRpc, 'estimateFees'>,
  builder: StarknetExternalBuilder,
  account: StarknetAccountRef,
  calls: readonly StarknetCall[],
  signal?: AbortSignal
): Promise<{ readonly deploy: StarknetPreparedFee; readonly invoke: StarknetPreparedFee }> {
  const deployProbe = starknetDeployExternalRequest({
    chainId: account.chainId,
    publicKey: account.publicKey,
    accountAddress: account.address,
    classHash: account.classHash,
    nonce: feltFromBigint(0n),
    resourceBounds: PLACEHOLDER_BOUNDS
  })
  const invokeProbe = starknetInvokeExternalRequest({
    chainId: account.chainId,
    publicKey: account.publicKey,
    accountAddress: account.address,
    classHash: account.classHash,
    calls,
    nonce: feltFromBigint(1n),
    resourceBounds: PLACEHOLDER_BOUNDS
  })
  const estimates = await rpc.estimateFees(
    [
      starknetDeployFeeEstimateTransaction(deployProbe, starknetDeployProbeSummary(deployProbe)),
      starknetInvokeFeeEstimateTransaction(invokeProbe, starknetInvokeProbeSummary(invokeProbe))
    ],
    signal
  )
  const deployEstimate = estimates[0]
  const invokeEstimate = estimates[1]
  if (!deployEstimate || !invokeEstimate) throw new Error('Starknet fee estimate is missing')
  const deployBounds = inflateStarknetFeeEstimate(deployEstimate)
  const invokeBounds = inflateStarknetFeeEstimate(invokeEstimate)
  return {
    deploy: {
      nonce: feltFromBigint(0n),
      resourceBounds: deployBounds,
      maxFee: starknetBoundsMaxFee(deployBounds),
      estimate: deployEstimate,
      unsigned: await prepareDeploy(builder, account, deployBounds)
    },
    invoke: {
      nonce: feltFromBigint(1n),
      resourceBounds: invokeBounds,
      maxFee: starknetBoundsMaxFee(invokeBounds),
      estimate: invokeEstimate,
      unsigned: await prepareInvoke(builder, account, calls, 1n, invokeBounds)
    }
  }
}

async function prepareInvoke(
  builder: StarknetExternalBuilder,
  account: StarknetAccountRef,
  calls: readonly StarknetCall[],
  nonce: bigint,
  resourceBounds: StarknetResourceBounds
): Promise<StarknetUnsignedBuild> {
  const request = starknetInvokeExternalRequest({
    chainId: account.chainId,
    publicKey: account.publicKey,
    accountAddress: account.address,
    classHash: account.classHash,
    calls,
    nonce: feltFromBigint(nonce),
    resourceBounds
  })
  const prepared = parseStarknetExternalPreparation(await builder.prepareInvoke(request))
  assertStarknetInvokeSummary(request, prepared.summary)
  return {
    transactionHash: prepared.signingHash,
    transaction: prepared.summary,
    query: false
  }
}

async function prepareDeploy(
  builder: StarknetExternalBuilder,
  account: StarknetAccountRef,
  resourceBounds: StarknetResourceBounds
): Promise<StarknetUnsignedBuild> {
  const request = starknetDeployExternalRequest({
    chainId: account.chainId,
    publicKey: account.publicKey,
    accountAddress: account.address,
    classHash: account.classHash,
    nonce: feltFromBigint(0n),
    resourceBounds
  })
  const prepared = parseStarknetExternalPreparation(await builder.prepareDeploy(request))
  assertStarknetDeploySummary(request, prepared.summary)
  return {
    transactionHash: prepared.signingHash,
    transaction: prepared.summary,
    query: false
  }
}

function canDeployStarknetAccount(classHash: string): boolean {
  const normalized = normalizeStarknetFelt(classHash)
  return (
    normalized === normalizeStarknetFelt(STARKNET_OZ_CLASS_HASH) ||
    normalized === normalizeStarknetFelt(STARKNET_ARGENT_V04_CLASS_HASH)
  )
}
