import { decodeFunctionData, parseAbi } from 'viem'
import { parseTransactionId } from '@/core/transactions/domain'
import { parseAccountId } from '@/core/accounts/domain'
import { parseKeyDomainId } from '@/core/keyring/domain'
import { IndexedDbTransactionRepository } from '@/infrastructure/persistence/repositories'
import type { BackgroundEvmTransferRouter } from './evm-transfer-router'

const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const PREFIX = 'swap_approval_continuation_v1:'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const RAW = /^[1-9]\d*$/

export interface SwapApprovalContinuation {
  readonly transactionId: string
  readonly network: 'mainnet' | 'testnet'
  readonly walletId: string
  readonly accountId: string
  readonly chainId: string
  readonly token: string
  readonly spender: string
  readonly owner: string
  readonly amountRaw: string
  readonly sourceAssetId: string
  readonly destinationAssetId: string
  readonly amountIn: string
  readonly recipientAddress: string
  readonly sourceMode: 'main' | 'private'
  readonly destinationMode: 'main' | 'private'
  readonly customRecipient: boolean
  readonly createdAt: number
}

export type SwapApprovalContinuationInput = Omit<SwapApprovalContinuation, 'createdAt'>
type ActiveScope = { network: string; walletId: string | null; accountId: string | null }
type ReadActiveScope = () => Promise<ActiveScope>

function matchesActive(record: SwapApprovalContinuationInput, active: ActiveScope): boolean {
  return (
    record.network === active.network &&
    record.walletId === active.walletId &&
    record.accountId === active.accountId
  )
}

function parseInput(value: unknown): SwapApprovalContinuationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Swap continuation')
  const item = value as Record<string, unknown>
  const transactionId = parseTransactionId(item.transactionId)
  if (
    (item.network !== 'mainnet' && item.network !== 'testnet') ||
    !['walletId', 'accountId', 'sourceAssetId', 'destinationAssetId', 'recipientAddress'].every(
      key =>
        typeof item[key] === 'string' &&
        (item[key] as string).length > 0 &&
        (item[key] as string).length <= 256
    ) ||
    typeof item.chainId !== 'string' ||
    !/^eip155:\d+$/.test(item.chainId) ||
    ![item.token, item.spender, item.owner].every(
      address => typeof address === 'string' && ADDRESS.test(address)
    ) ||
    typeof item.amountRaw !== 'string' ||
    !RAW.test(item.amountRaw) ||
    item.amountRaw.length > 78 ||
    typeof item.amountIn !== 'string' ||
    !DECIMAL.test(item.amountIn) ||
    item.amountIn.length > 80 ||
    (item.sourceMode !== 'main' && item.sourceMode !== 'private') ||
    (item.destinationMode !== 'main' && item.destinationMode !== 'private') ||
    typeof item.customRecipient !== 'boolean'
  )
    throw new Error('Invalid Swap continuation')
  return {
    transactionId,
    network: item.network,
    walletId: item.walletId as string,
    accountId: item.accountId as string,
    chainId: item.chainId,
    token: item.token as string,
    spender: item.spender as string,
    owner: item.owner as string,
    amountRaw: item.amountRaw,
    sourceAssetId: item.sourceAssetId as string,
    destinationAssetId: item.destinationAssetId as string,
    amountIn: item.amountIn,
    recipientAddress: item.recipientAddress as string,
    sourceMode: item.sourceMode,
    destinationMode: item.destinationMode,
    customRecipient: item.customRecipient
  }
}

function key(transactionId: string): string {
  return `${PREFIX}${parseTransactionId(transactionId)}`
}

export async function saveSwapApprovalContinuation(
  input: unknown,
  router: BackgroundEvmTransferRouter,
  readActive: ReadActiveScope
): Promise<SwapApprovalContinuation> {
  const parsed = parseInput(input)
  if (!matchesActive(parsed, await readActive()))
    throw new Error('Active account changed. Review this Swap again.')
  const external = await router.getExternalSigningRequest(parsed.transactionId)
  if (
    !external ||
    external.vendor !== 'ledger' ||
    external.chainId !== parsed.chainId ||
    external.scope.keyDomainId !== parsed.walletId ||
    external.scope.accountId !== parsed.accountId ||
    external.summary.schema !== 'evm.transaction.v1'
  )
    throw new Error('Ledger approval is unavailable')
  const fields = external.summary.fields
  if (
    fields.to?.toLowerCase() !== parsed.token.toLowerCase() ||
    fields.from.toLowerCase() !== parsed.owner.toLowerCase() ||
    fields.valueWei !== '0'
  )
    throw new Error('Approval transaction does not match this Swap')
  let spender: string
  let approved: bigint
  try {
    const decoded = decodeFunctionData({
      abi: APPROVE_ABI,
      data: fields.calldata.value as `0x${string}`
    })
    if (decoded.functionName !== 'approve') throw new Error('Not an approval')
    ;[spender, approved] = decoded.args
  } catch {
    throw new Error('Approval transaction does not match this Swap')
  }
  if (spender.toLowerCase() !== parsed.spender.toLowerCase() || approved < BigInt(parsed.amountRaw))
    throw new Error('Approval transaction does not match this Swap')
  if (!matchesActive(parsed, await readActive()))
    throw new Error('Active account changed. Review this Swap again.')
  const record = Object.freeze({ ...parsed, createdAt: Date.now() })
  await chrome.storage.local.set({ [key(parsed.transactionId)]: record })
  if (!matchesActive(parsed, await readActive())) {
    await chrome.storage.local.remove(key(parsed.transactionId))
    throw new Error('Active account changed. Review this Swap again.')
  }
  return record
}

export async function readSwapApprovalContinuation(
  transactionId: string,
  readActive: ReadActiveScope
): Promise<SwapApprovalContinuation | null> {
  const storageKey = key(transactionId)
  const raw = (await chrome.storage.local.get(storageKey))[storageKey]
  if (!raw) return null
  let record: SwapApprovalContinuation
  try {
    const parsed = parseInput(raw)
    const createdAt = (raw as { createdAt?: unknown }).createdAt
    if (
      typeof createdAt !== 'number' ||
      !Number.isSafeInteger(createdAt) ||
      createdAt > Date.now() ||
      Date.now() - createdAt > MAX_AGE_MS ||
      parsed.transactionId !== transactionId
    )
      throw new Error('Expired')
    record = { ...parsed, createdAt }
  } catch {
    await chrome.storage.local.remove(storageKey)
    return null
  }
  if (!matchesActive(record, await readActive())) return null
  const graph = await new IndexedDbTransactionRepository().get(
    { keyDomainId: parseKeyDomainId(record.walletId), accountId: parseAccountId(record.accountId) },
    parseTransactionId(record.transactionId)
  )
  if (!graph || graph.root.status === 'failed') {
    await chrome.storage.local.remove(storageKey)
    return null
  }
  if (
    graph.root.kind !== 'approve' ||
    graph.segments[0]?.target.kind !== 'onchain' ||
    graph.segments[0].target.chainId !== record.chainId
  )
    return null
  if (!matchesActive(record, await readActive())) return null
  return record
}

export async function continueSwapAfterApproval(
  transactionId: string,
  router: BackgroundEvmTransferRouter,
  readActive: ReadActiveScope
): Promise<SwapApprovalContinuation> {
  const record = await readSwapApprovalContinuation(transactionId, readActive)
  if (!record) throw new Error('Swap continuation is unavailable. Start a new Swap.')
  const graph = await new IndexedDbTransactionRepository().get(
    { keyDomainId: parseKeyDomainId(record.walletId), accountId: parseAccountId(record.accountId) },
    parseTransactionId(record.transactionId)
  )
  if (graph?.root.status !== 'final')
    throw new Error('Token approval is not confirmed yet. Check Activity and try again.')
  const allowance = await router.getTokenAllowance(
    record.chainId,
    record.token,
    record.spender,
    record.owner,
    record.sourceMode
  )
  if (BigInt(allowance) < BigInt(record.amountRaw))
    throw new Error('Token allowance is not available. Check Activity and try again.')
  if (!matchesActive(record, await readActive()))
    throw new Error('Active account changed. Review this Swap again.')
  return record
}

export async function clearSwapApprovalContinuation(transactionId: string): Promise<void> {
  await chrome.storage.local.remove(key(transactionId))
}

export async function clearSwapApprovalContinuationsForAccount(
  walletId: string,
  accountId: string
): Promise<void> {
  const stored = await chrome.storage.local.get(null)
  const keys = Object.keys(stored).filter(candidate => {
    if (!candidate.startsWith(PREFIX)) return false
    const record = stored[candidate]
    return (
      record &&
      typeof record === 'object' &&
      record.walletId === walletId &&
      record.accountId === accountId
    )
  })
  if (keys.length) await chrome.storage.local.remove(keys)
}

export async function clearAllSwapApprovalContinuations(): Promise<void> {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter(candidate =>
    candidate.startsWith(PREFIX)
  )
  if (keys.length) await chrome.storage.local.remove(keys)
}
