import { normalizeStarknetFelt } from '@/core/chains/starknet/identifiers'
import { StarknetMultichainSigningClient } from '@/infrastructure/keyring/multichain/starknet-signing-client'

const FELT_PRIME = 0x800000000000011000000000000000000000000000000000000000000000001n

export async function computeStarknetLedgerAddress(
  publicKey: string,
  chainId: 'starknet:SN_MAIN' | 'starknet:SN_SEPOLIA'
): Promise<{
  readonly address: string
  readonly classHash: string
}> {
  let normalizedKey: string
  try {
    normalizedKey = normalizeStarknetFelt(publicKey)
  } catch {
    throw new Error('Starknet public key is invalid')
  }
  if (BigInt(normalizedKey) >= FELT_PRIME) throw new Error('Starknet public key is invalid')
  const signing = new StarknetMultichainSigningClient({
    credentials: {
      getCredentialBinding: async () => {
        throw new Error('Ledger Starknet address derivation does not use a software key')
      }
    }
  })
  const result = await signing.computeAddress({
    chainId,
    publicKey: normalizedKey,
    implementation: 'argent_v04'
  })
  if (typeof result !== 'object' || result === null) {
    throw new Error('Starknet compute-address result is invalid')
  }
  const address = Reflect.get(result, 'address')
  const classHash = Reflect.get(result, 'classHash')
  if (typeof address !== 'string' || typeof classHash !== 'string') {
    throw new Error('Starknet compute-address result is invalid')
  }
  return {
    address: normalizeStarknetFelt(address),
    classHash: normalizeStarknetFelt(classHash)
  }
}
