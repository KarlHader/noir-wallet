import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'

import {
  STARKNET_ARGENT_V04_CLASS_HASH,
  STARKNET_ARGENT_V05_CLASS_HASH,
  STARKNET_OZ_CLASS_HASH
} from './starknet-primitives'
import { StarknetRpcError, type StarknetReadRpc } from './starknet-rpc-types'

export type StarknetAccountImplementation = 'open_zeppelin' | 'argent_v0_4' | 'argent_v0_5'

export interface StarknetAccountDeployment {
  readonly deployed: boolean
  readonly implementation: StarknetAccountImplementation | null
  readonly classHash: string | null
  readonly nonce: bigint
}

const ALLOWED = new Map<string, StarknetAccountImplementation>([
  [normalizeStarknetFelt(STARKNET_OZ_CLASS_HASH), 'open_zeppelin'],
  [normalizeStarknetFelt(STARKNET_ARGENT_V04_CLASS_HASH), 'argent_v0_4'],
  [normalizeStarknetFelt(STARKNET_ARGENT_V05_CLASS_HASH), 'argent_v0_5']
])

export async function readStarknetAccountDeployment(
  rpc: Pick<StarknetReadRpc, 'getClassHashAt' | 'getNonce'>,
  address: string,
  signal?: AbortSignal
): Promise<StarknetAccountDeployment> {
  const classHash = await rpc.getClassHashAt(address, signal)
  if (classHash === null) {
    return { deployed: false, implementation: null, classHash: null, nonce: 0n }
  }
  const implementation = ALLOWED.get(classHash) ?? null
  if (!implementation) {
    throw new StarknetRpcError('invalid-response', 'Starknet account class is not enabled')
  }
  let nonce = 0n
  try {
    nonce = await rpc.getNonce(address, signal)
  } catch (error) {
    if (!(error instanceof StarknetRpcError) || error.code !== 'contract-not-found') throw error
  }
  return { deployed: true, implementation, classHash, nonce }
}
