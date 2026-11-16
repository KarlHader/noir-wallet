import type { ChainId } from '@/core/chains/domain'
import type { SigningOperation, SigningSummary } from '@/core/keyring/domain'

export type { SigningOperation, SigningSummary } from '@/core/keyring/domain'

declare const signingCommandIdBrand: unique symbol

export type SigningCommandId = string & { readonly [signingCommandIdBrand]: true }

export type EncodedPayload =
  | {
      readonly encoding: 'bytes'
      readonly value: Uint8Array
    }
  | {
      readonly encoding: 'hex' | 'base64' | 'utf8'
      readonly value: string
    }

export type SigningExecution =
  | {
      readonly kind: 'internal'
    }
  | {
      readonly kind: 'external'
      readonly request: EncodedPayload
    }

export interface PreparedSigningCommand {
  readonly commandId: SigningCommandId
  readonly chainId: ChainId
  readonly operation: SigningOperation
  readonly summary: SigningSummary
  readonly payloadFingerprint: {
    readonly algorithm: 'sha256'
    readonly digestHex: string
  }
  readonly execution: SigningExecution
  readonly expiresAt: number
}

export type ConfirmSigningCommand =
  | {
      readonly commandId: SigningCommandId
      readonly execution: 'internal'
    }
  | {
      readonly commandId: SigningCommandId
      readonly execution: 'external'
      readonly response: EncodedPayload
    }

export type SigningResult =
  | {
      readonly kind: 'broadcast'
      readonly transactionId: string
    }
  | {
      readonly kind: 'signed-payload'
      readonly payload: EncodedPayload
      readonly transactionId?: string
    }
  | {
      readonly kind: 'signature'
      readonly signature: EncodedPayload
      readonly publicKey: string
      readonly address?: string
    }

export function parseSigningCommandId(value: string): SigningCommandId {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error('SigningCommandId must be a non-empty string without surrounding whitespace')
  }
  return value as SigningCommandId
}
