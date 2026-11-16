import { parseChainId } from '@/core/chains/registry'
import { createEvmRpcClient } from './evm-rpc-client'

export interface AttestEvmRpcEndpointInput {
  readonly chainId: string
  readonly rpcUrl: string
  readonly signal?: AbortSignal
}

export async function attestEvmRpcEndpoint(input: AttestEvmRpcEndpointInput): Promise<void> {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'eip155') throw new Error('EVM RPC attestation requires an EVM chain')
  const rpc = createEvmRpcClient({ chainId: chainId.id, rpcUrl: input.rpcUrl })
  await rpc.assertExpectedChain(input.signal)
}
