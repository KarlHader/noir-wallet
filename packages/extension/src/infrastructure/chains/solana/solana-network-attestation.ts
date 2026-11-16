import { parseChainId } from '@/core/chains/registry'
import { createSolanaRpcClient, SolanaRpcError } from './solana-rpc-client'

export interface AttestSolanaRpcEndpointInput {
  readonly chainId: string
  readonly rpcUrl: string
  readonly signal?: AbortSignal
}

export async function attestSolanaRpcEndpoint(input: AttestSolanaRpcEndpointInput): Promise<void> {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'solana') {
    throw new Error('Solana RPC attestation requires a Solana chain')
  }
  const client = createSolanaRpcClient({ chainId: chainId.id, rpcUrl: input.rpcUrl })
  await client.assertExpectedChain(input.signal)
  const blockHeight = await client.getBlockHeight(input.signal)
  const latestBlockhash = await client.getLatestBlockhash(input.signal)
  if (
    blockHeight > latestBlockhash.lastValidBlockHeight ||
    latestBlockhash.lastValidBlockHeight - blockHeight > 10_000
  ) {
    throw new SolanaRpcError(
      'invalid-response',
      'Solana RPC returned inconsistent block-height evidence'
    )
  }
}
