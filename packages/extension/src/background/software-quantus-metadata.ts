import { resolveQuantusDerivationScheme } from '@/core/chains/quantus'
import { getQuantusChainId } from '@/core/chains/registry'
import { parseKeyDomainId } from '@/core/keyring/domain'
import type { DerivedQuantusNetworkAccount } from '@/infrastructure/keyring/network-account-metadata-coordinator'
import { QuantusMultichainDerivationClient } from '@/infrastructure/keyring/multichain/quantus-derivation-client'
import type { Network } from '@/types'
import { credentialSession } from './credential-session'

export interface DeriveSoftwareQuantusMetadataInput {
  readonly keyDomainId: string
  readonly accountIndex: number
  readonly network: Network
  readonly quantusEnabled: boolean
  readonly scheme?: unknown
}

export interface SoftwareQuantusNetworkMetadata {
  readonly quantus?: DerivedQuantusNetworkAccount
}

const quantusDerivation = new QuantusMultichainDerivationClient({
  credentials: credentialSession
})

/**
 * Derives the index-0 Quantus address a software Account can sign with. The
 * Worker signs only `change=false` / `address_index=0`, so the projection keeps
 * a single spendable identity per Account and refuses any other coordinates.
 */
export async function deriveSoftwareQuantusMetadata(
  input: DeriveSoftwareQuantusMetadataInput
): Promise<SoftwareQuantusNetworkMetadata> {
  if (!input.quantusEnabled) return Object.freeze({})
  const scheme = resolveQuantusDerivationScheme(input.scheme)
  const derived = await quantusDerivation.deriveAddress(parseKeyDomainId(input.keyDomainId), {
    chainId: getQuantusChainId(input.network),
    scheme,
    accountIndex: input.accountIndex,
    change: false,
    addressIndex: 0
  })
  if (derived.change || derived.addressIndex !== 0 || derived.accountIndex !== input.accountIndex) {
    throw new Error('Derived Quantus account does not match the requested coordinates')
  }
  return Object.freeze({
    quantus: Object.freeze({
      chainId: derived.chainId,
      address: derived.address,
      publicKey: derived.publicKey,
      accountId: derived.accountId,
      scheme: derived.scheme,
      derivationPath: derived.derivationPath
    })
  })
}
