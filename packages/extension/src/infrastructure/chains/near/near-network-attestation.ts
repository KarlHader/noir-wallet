import { parseChainId } from '@/core/chains/registry'

import { createNearRpcClient } from './near-rpc-client'

export interface AttestNearRpcEndpointInput {
  readonly chainId: string
  readonly rpcUrl: string
  readonly signal?: AbortSignal
}

export async function attestNearRpcEndpoint(input: AttestNearRpcEndpointInput): Promise<void> {
  const chainId = parseChainId(input.chainId)
  if (chainId.namespace !== 'near') {
    throw new Error('NEAR RPC attestation requires a NEAR chain')
  }
  await createNearRpcClient({ chainId: chainId.id, rpcUrl: input.rpcUrl }).assertExpectedChain(
    input.signal
  )
}
