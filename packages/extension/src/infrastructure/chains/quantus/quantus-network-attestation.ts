import { parseChainId } from '@/core/chains/registry'

import { createQuantusRpcClient } from './quantus-rpc-client'

export interface AttestQuantusRpcEndpointInput {
  readonly chainId: string
  readonly rpcUrl: string
  readonly signal?: AbortSignal
}

export async function attestQuantusRpcEndpoint(
  input: AttestQuantusRpcEndpointInput
): Promise<void> {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'quantus') {
    throw new Error('Quantus RPC attestation requires a Quantus chain')
  }
  await createQuantusRpcClient({
    chainId: chainId.id,
    rpcUrl: input.rpcUrl
  }).assertExpectedChain(input.signal)
}
