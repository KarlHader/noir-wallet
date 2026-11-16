import type { ChainAccountIdentity } from '@/core/chains/domain'
import type { ChainAccountScope } from '@/core/accounts/domain'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { ConfirmSigningCommand, PreparedSigningCommand, SigningResult } from './signing'

export type ZcashSigningIntent =
  | {
      readonly kind: 'transfer'
      readonly recipient: string
      readonly amountZats: string
      readonly memo?: string
      readonly fundingSource: 'transparent' | 'shielded'
      readonly marginalFeeZats?: string
    }
  | {
      readonly kind: 'shield'
      readonly marginalFeeZats?: string
    }
  | {
      readonly kind: 'message'
      readonly message: string
      readonly addressIndex?: number
    }

export interface ZcashPrepareSigningInput {
  readonly scope: ChainAccountScope
  readonly intent: ZcashSigningIntent
}

export interface ZcashPublicIdentityInput {
  readonly scope: ChainAccountScope
  readonly addressIndex?: number
}

export interface ZcashSignerPort {
  readonly getPublicIdentity: (input: ZcashPublicIdentityInput) => Promise<ChainAccountIdentity>
  readonly prepare: (input: ZcashPrepareSigningInput) => Promise<PreparedSigningCommand>
  readonly confirm: (input: ConfirmSigningCommand) => Promise<SigningResult>
  readonly cancel: (commandId: PreparedSigningCommand['commandId']) => Promise<void>
  readonly cancelAll: (keyDomainId: KeyDomainId) => Promise<void>
}
