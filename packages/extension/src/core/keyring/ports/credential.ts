import type { CredentialRef, KeyDomainId } from '@/core/keyring/domain'

export interface CredentialUnlockInput {
  readonly keyDomainId: KeyDomainId
  readonly credentialRef: CredentialRef
  readonly password: string
}

export interface CredentialAccessState {
  readonly keyDomainId: KeyDomainId
  readonly unlocked: boolean
}

export interface CredentialAccessPort {
  readonly engine: 'zcash' | 'multichain'
  readonly unlock: (input: CredentialUnlockInput) => Promise<void>
  readonly lock: (keyDomainId: KeyDomainId) => Promise<void>
  readonly lockAll: () => Promise<void>
  readonly getAccessState: (keyDomainId: KeyDomainId) => Promise<CredentialAccessState>
}

export interface ZcashCredentialPort extends CredentialAccessPort {
  readonly engine: 'zcash'
}

export interface MultichainVaultPort extends CredentialAccessPort {
  readonly engine: 'multichain'
}
