import type { ChainAccountIdentity, ChainId, DerivationDescriptor } from '@/core/chains/domain'
import type { AccountIndex, AddressPurpose, ChainAccountScope } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import type {
  ConfirmSigningCommand,
  EncodedPayload,
  PreparedSigningCommand,
  SigningOperation,
  SigningResult
} from './signing'

export interface MultichainDeriveAccountInput {
  readonly keyDomainId: KeyDomainId
  readonly accountIndex: AccountIndex
  readonly chainId: ChainId
  readonly derivation: DerivationDescriptor
}

export interface DerivedPublicAddress {
  readonly value: string
  readonly scheme: string
  readonly purpose: AddressPurpose
  readonly derivation?: DerivationDescriptor
}

export interface DerivedPublicAccount {
  readonly chainId: ChainId
  readonly derivation: DerivationDescriptor
  readonly identity: ChainAccountIdentity
  readonly addresses: readonly DerivedPublicAddress[]
}

export interface MultichainPrepareSigningInput {
  readonly scope: ChainAccountScope
  readonly operation: SigningOperation
  readonly payloadFormat: string
  readonly payload: EncodedPayload
  readonly expectedSigner: ChainAccountIdentity
}

export interface MultichainSignerPort {
  readonly derivePublicAccount: (
    input: MultichainDeriveAccountInput
  ) => Promise<DerivedPublicAccount>
  readonly prepare: (input: MultichainPrepareSigningInput) => Promise<PreparedSigningCommand>
  readonly confirm: (input: ConfirmSigningCommand) => Promise<SigningResult>
  readonly cancel: (commandId: PreparedSigningCommand['commandId']) => Promise<void>
  readonly cancelAll: (keyDomainId: KeyDomainId) => Promise<void>
}
