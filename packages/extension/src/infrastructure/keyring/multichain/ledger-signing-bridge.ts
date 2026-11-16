import type { ChainId } from '@/core/chains/domain'
import type { KeyDomainId, SigningSummary } from '@/core/keyring/domain'
import type { PreparedSigningCommand } from '@/core/keyring/ports'

export interface LedgerSigningResume<Payload> {
  readonly accountId: string
  readonly payload: Payload
  readonly prepared: PreparedSigningCommand
}

export interface LedgerSigningAccountBinding {
  readonly accountId: string
  readonly path: string
  readonly publicKey: string
  readonly address: string
}

export interface LedgerSigningBinding {
  readonly scope: {
    readonly keyDomainId: KeyDomainId
    readonly accountId: string
    readonly chainId: ChainId
  }
  readonly payloadFingerprint: { readonly algorithm: 'sha256'; readonly digestHex: string }
  readonly expiresAt: number
  readonly origin?: string
  readonly summary: SigningSummary
  readonly validate: () => Promise<void>
  readonly signal?: AbortSignal
}

export interface LedgerSigningBridge<Request, Response> {
  readonly resolveAccount: (
    keyDomainId: KeyDomainId,
    chainId: ChainId,
    accountIndex: number
  ) => Promise<LedgerSigningAccountBinding | null>
  readonly requestSignature: (request: Request, binding: LedgerSigningBinding) => Promise<Response>
}

export function sameLedgerAccount(
  left: LedgerSigningAccountBinding,
  right: LedgerSigningAccountBinding | null
): boolean {
  return (
    !!right &&
    left.accountId === right.accountId &&
    left.path === right.path &&
    left.publicKey === right.publicKey &&
    left.address === right.address
  )
}
