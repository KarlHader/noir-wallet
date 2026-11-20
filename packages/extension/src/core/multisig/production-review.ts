import { zcashNodeRpc } from '@/lib/zcash-node-rpc'
import { assertPcztConsensusPolicy, reviewPreparedPczt } from './pczt-review'
import type * as WalletWasm from '@/lib/wasm-pkg/zcash_wallet_wasm'

const MIN_SYNC_PROGRESS = 0.999
const MAX_CHAIN_TIP_AGE_SECONDS = 30 * 60
const MAX_FUTURE_BLOCK_SKEW_SECONDS = 2 * 60

export interface VerifiedMultisigChainTip {
  height: number
  consensusBranchId: number
}

export interface ReviewedMultisigChainPolicy {
  expiryHeight: number
  consensusBranchId: number
}

export interface ProductionMultisigPaymentInput {
  accountId: number
  network: 'mainnet' | 'testnet'
  recipient: string
  expectedRecipientRaw: Uint8Array
  amountZats: string
  memo: string
  marginalFeeZats: number
  fvk: Uint8Array
  groupVerifyingKey: Uint8Array
  chainTip: VerifiedMultisigChainTip
  assertAuthorized: () => void
}

interface ProductionPcztWallet {
  estimate_pczt_transfer_fee(
    accountId: number,
    recipient: string,
    amount: bigint,
    memo: Uint8Array | undefined,
    marginalFeeZats: bigint
  ): Promise<bigint>
  pczt_create(
    accountId: number,
    recipient: string,
    amount: bigint,
    memo: Uint8Array | undefined,
    marginalFeeZats: bigint
  ): Promise<{ serialize(): Uint8Array; free(): void }>
}

export async function prepareProductionMultisigPayment(
  wasm: Pick<typeof WalletWasm, 'PcztTools'>,
  wallet: ProductionPcztWallet,
  input: ProductionMultisigPaymentInput
): Promise<{
  pczt: Uint8Array
  summary: { recipient: string; amount: string; memo: string; fee: string }
  reviewedChainPolicy: ReviewedMultisigChainPolicy
}> {
  const { accountId, network, recipient, amountZats, memo, marginalFeeZats, chainTip } = input
  if (
    !Number.isSafeInteger(accountId) ||
    accountId < 0 ||
    !/^[1-9][0-9]*$/.test(amountZats) ||
    !Number.isSafeInteger(marginalFeeZats) ||
    marginalFeeZats <= 0
  )
    throw new Error('Invalid multisig PCZT preparation')
  const memoBytes = memo ? new TextEncoder().encode(memo) : undefined
  const amount = BigInt(amountZats)
  const feeRate = BigInt(marginalFeeZats)
  input.assertAuthorized()
  const maxFee = await wallet.estimate_pczt_transfer_fee(
    accountId,
    recipient,
    amount,
    memoBytes,
    feeRate
  )
  input.assertAuthorized()
  if (typeof maxFee !== 'bigint' || maxFee <= 0n || maxFee > 2_100_000_000_000_000n)
    throw new Error('Invalid multisig fee estimate')
  input.assertAuthorized()
  const built = await wallet.pczt_create(accountId, recipient, amount, memoBytes, feeRate)
  let pczt: Uint8Array | null = null
  try {
    input.assertAuthorized()
    pczt = built.serialize()
    const reviewed = reviewPreparedPczt(wasm, {
      pczt,
      fvk: input.fvk,
      groupVerifyingKey: input.groupVerifyingKey,
      network,
      chainTipHeight: chainTip.height,
      recipient,
      expectedRecipientRaw: input.expectedRecipientRaw,
      amountZats,
      memo,
      maxFeeZats: String(maxFee)
    })
    assertPcztConsensusPolicy(
      network,
      chainTip.height,
      chainTip.consensusBranchId,
      reviewed.expiryHeight
    )
    return {
      pczt,
      summary: reviewed.summary,
      reviewedChainPolicy: {
        expiryHeight: reviewed.expiryHeight,
        consensusBranchId: chainTip.consensusBranchId
      }
    }
  } catch (error) {
    pczt?.fill(0)
    throw error
  } finally {
    built.free()
  }
}

export async function getVerifiedMultisigChainTip(
  network: 'mainnet' | 'testnet',
  rpcUrl: string
): Promise<VerifiedMultisigChainTip> {
  if (!rpcUrl) throw new Error('Zcash chain identity is unavailable')
  const raw: unknown = await zcashNodeRpc(rpcUrl, 'getblockchaininfo')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Zcash chain identity is unavailable')
  const info = raw as Record<string, unknown>
  const consensus = info.consensus
  const branch =
    consensus && typeof consensus === 'object' && !Array.isArray(consensus)
      ? (consensus as Record<string, unknown>).nextblock
      : undefined
  if (
    info.chain !== (network === 'mainnet' ? 'main' : 'test') ||
    !Number.isSafeInteger(info.blocks) ||
    Number(info.blocks) < 0 ||
    Number(info.blocks) > 0xffffffff ||
    !Number.isSafeInteger(info.headers) ||
    Number(info.headers) !== Number(info.blocks) ||
    (info.estimatedheight !== undefined &&
      (!Number.isSafeInteger(info.estimatedheight) || Number(info.estimatedheight) < 0)) ||
    typeof info.verificationprogress !== 'number' ||
    !Number.isFinite(info.verificationprogress) ||
    info.verificationprogress < MIN_SYNC_PROGRESS ||
    info.verificationprogress > 1 ||
    info.initial_block_download_complete === false ||
    typeof info.bestblockhash !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(info.bestblockhash) ||
    typeof branch !== 'string' ||
    !/^[0-9a-fA-F]{8}$/.test(branch)
  )
    throw new Error('Zcash chain identity is unavailable')
  const height = info.blocks as number
  const consensusBranchId = Number.parseInt(branch, 16)
  assertPcztConsensusPolicy(network, height, consensusBranchId, height + 1)
  const header: unknown = await zcashNodeRpc(rpcUrl, 'getblockheader', [info.bestblockhash])
  if (!header || typeof header !== 'object' || Array.isArray(header))
    throw new Error('Zcash chain tip is unavailable')
  const block = header as Record<string, unknown>
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (
    typeof block.hash !== 'string' ||
    block.hash.toLowerCase() !== info.bestblockhash.toLowerCase() ||
    block.height !== height ||
    !Number.isSafeInteger(block.time) ||
    Number(block.time) < nowSeconds - MAX_CHAIN_TIP_AGE_SECONDS ||
    Number(block.time) > nowSeconds + MAX_FUTURE_BLOCK_SKEW_SECONDS
  )
    throw new Error('Zcash chain tip is unavailable')
  return { height, consensusBranchId }
}

export async function assertFreshMultisigReview(
  network: 'mainnet' | 'testnet',
  rpcUrl: string,
  reviewed: ReviewedMultisigChainPolicy
): Promise<void> {
  const tip = await getVerifiedMultisigChainTip(network, rpcUrl)
  assertPcztConsensusPolicy(network, tip.height, reviewed.consensusBranchId, reviewed.expiryHeight)
  if (tip.consensusBranchId !== reviewed.consensusBranchId)
    throw new Error('Multisig consensus branch changed')
}
