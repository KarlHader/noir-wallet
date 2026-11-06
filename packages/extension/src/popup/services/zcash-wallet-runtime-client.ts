import type { MnemonicWordCount } from '@/config/wallet'
import { getResponseErrorMessage } from '@/lib/errors'
import type { WalletBackupVerification } from '@/core/wallet/secret-phrase-backup'
import type { AccountAddresses, FundingSource } from '@/types'
import type { BirthdayHeightSource } from '@/lib/zcash-birthday'
import type { BallotDecision } from '@/core/worker/types'
import { isValidMarginalFeeZats, type FeeQuote, type QuotedFeeEstimate } from '@/config/fee'

type RuntimeResponse = Record<string, unknown>

export interface UnlockResult {
  readonly success: boolean
  readonly upgradeFailed?: boolean
  readonly isLocked?: boolean
  readonly remainingAttempts?: number
  readonly lockRemainingMs?: number
  readonly failure?:
    | 'wrong_password'
    | 'credential_missing'
    | 'credential_invalid'
    | 'operation_failed'
}

export interface MaxTransferEstimate {
  readonly maxAmountZats: string
  readonly feeZats: string
  readonly marginalFeeZats: string
  readonly feeQuote: FeeQuote
}

export interface ResolvedBirthdayHeight {
  readonly height: number
  readonly source: BirthdayHeightSource
}

export type NextZcashAccountHistoryInspection = {
  readonly derivationIndex: number
  readonly status: 'used' | 'unknown'
  readonly birthdayHeight?: number
}

function responseRecord(value: unknown): RuntimeResponse | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RuntimeResponse)
    : null
}

async function send(message: Readonly<Record<string, unknown>>): Promise<RuntimeResponse> {
  const response = responseRecord(await chrome.runtime.sendMessage(message))
  if (!response) throw new Error('Wallet Background returned an invalid response')
  return response
}

async function expectSuccess(
  message: Readonly<Record<string, unknown>>,
  fallback: string
): Promise<RuntimeResponse> {
  const response = await send(message)
  if (response.success !== true) throw new Error(getResponseErrorMessage(response) ?? fallback)
  return response
}

function requireString(response: RuntimeResponse, key: string, fallback: string): string {
  const value = response[key]
  if (typeof value !== 'string') throw new Error(fallback)
  return value
}

function requireFiniteNumber(response: RuntimeResponse, key: string, fallback: string): number {
  const value = response[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(fallback)
  return value
}

function requireFeeQuote(response: RuntimeResponse): FeeQuote {
  const value = response.feeQuote
  const quote = responseRecord(value)
  if (
    !quote ||
    typeof quote.id !== 'string' ||
    !quote.id ||
    !isValidMarginalFeeZats(quote.standardMarginalFeeZats) ||
    typeof quote.expiresAt !== 'number' ||
    !Number.isSafeInteger(quote.expiresAt)
  )
    throw new Error('Wallet Background returned an invalid network fee quote')
  return {
    id: quote.id,
    standardMarginalFeeZats: quote.standardMarginalFeeZats,
    expiresAt: quote.expiresAt
  }
}

function requireFeeEstimate(response: RuntimeResponse): QuotedFeeEstimate {
  return {
    feeZats: requireString(response, 'feeZats', 'Wallet Background returned an invalid fee'),
    marginalFeeZats: requireString(
      response,
      'marginalFeeZats',
      'Wallet Background returned an invalid marginal fee'
    ),
    feeQuote: requireFeeQuote(response)
  }
}

export const zcashWalletRuntimeClient = Object.freeze({
  async initialize(): Promise<void> {
    const response = await send({ type: 'GET_BACKGROUND_INITIALIZATION_STATE' })
    if (response.ready !== true) {
      throw new Error(getResponseErrorMessage(response) ?? 'Wallet Background is not ready')
    }
  },

  async unlock(password: string): Promise<UnlockResult> {
    const response = await send({ type: 'WALLET_UNLOCK', password })
    if (typeof response.error === 'string' && response.success !== false) {
      return { success: false, upgradeFailed: true }
    }
    return {
      success: response.success === true,
      ...(response.failure === 'wrong_password' ||
      response.failure === 'credential_missing' ||
      response.failure === 'credential_invalid' ||
      response.failure === 'operation_failed'
        ? { failure: response.failure }
        : {}),
      ...(typeof response.isLocked === 'boolean' ? { isLocked: response.isLocked } : {}),
      ...(typeof response.remainingAttempts === 'number'
        ? { remainingAttempts: response.remainingAttempts }
        : {}),
      ...(typeof response.lockRemainingMs === 'number'
        ? { lockRemainingMs: response.lockRemainingMs }
        : {})
    }
  },

  async lock(): Promise<void> {
    await expectSuccess({ type: 'WALLET_LOCKED' }, 'Wallet lock failed')
  },

  async reset(): Promise<void> {
    await expectSuccess({ type: 'RESET_WALLET_DATA' }, 'Wallet reset failed')
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await expectSuccess(
      { type: 'CHANGE_WALLET_PASSWORD', currentPassword, newPassword },
      'Password change failed'
    )
  },

  async generatePrimaryMnemonic(wordCount: MnemonicWordCount, password: string): Promise<string[]> {
    const response = await expectSuccess(
      { type: 'GENERATE_PRIMARY_WALLET_MNEMONIC', wordCount, password },
      'Recovery phrase generation failed'
    )
    const mnemonic = requireString(
      response,
      'mnemonic',
      'Wallet Background returned an invalid recovery phrase'
    )
    const words = mnemonic.split(' ')
    if (words.length !== wordCount) {
      throw new Error('Secure module returned an unexpected recovery phrase length')
    }
    return words
  },

  async provisionPrimarySoftwareWallet(input: {
    readonly mnemonic: string
    readonly password: string
    readonly accountName: string
    readonly birthdayHeight?: number
  }): Promise<void> {
    await expectSuccess(
      {
        type: 'PROVISION_PRIMARY_SOFTWARE_WALLET',
        mnemonic: input.mnemonic,
        password: input.password,
        accountName: input.accountName,
        ...(input.birthdayHeight === undefined ? {} : { birthdayHeight: input.birthdayHeight })
      },
      'Wallet setup failed'
    )
  },

  async getSeedPhrase(password: string, walletId?: string): Promise<string | null> {
    const response = await expectSuccess(
      { type: 'GET_ZCASH_SEED_PHRASE', password, ...(walletId ? { walletId } : {}) },
      'Failed to retrieve seed phrase'
    )
    if (response.seedPhrase === null) return null
    return requireString(response, 'seedPhrase', 'Wallet Background returned an invalid phrase')
  },

  async getWalletBackupWordIndices(walletId: string): Promise<[number, number]> {
    const response = await expectSuccess(
      { type: 'GET_WALLET_BACKUP_WORD_INDICES', walletId },
      'Unable to prepare backup verification'
    )
    const indices = response.wordIndices
    if (
      !Array.isArray(indices) ||
      indices.length !== 2 ||
      !indices.every(value => Number.isSafeInteger(value) && value >= 0 && value < 24) ||
      indices[0] === indices[1]
    ) {
      throw new Error('Wallet Background returned invalid backup word positions')
    }
    return [indices[0], indices[1]]
  },

  async confirmWalletBackup(
    walletId: string,
    verification: WalletBackupVerification
  ): Promise<void> {
    await expectSuccess(
      { type: 'CONFIRM_WALLET_BACKUP', walletId, verification },
      'Backup confirmation failed'
    )
  },

  async getBlockByTime(timestamp: number): Promise<number> {
    const response = await expectSuccess(
      { type: 'GET_ZCASH_BLOCK_BY_TIME', timestamp },
      'Unable to resolve Zcash block height'
    )
    return requireFiniteNumber(response, 'height', 'Wallet Background returned an invalid height')
  },

  async getBlockTime(height: number): Promise<number> {
    const response = await expectSuccess(
      { type: 'GET_ZCASH_BLOCK_TIME', height },
      'Unable to resolve Zcash block time'
    )
    return requireFiniteNumber(
      response,
      'timestamp',
      'Wallet Background returned an invalid block time'
    )
  },

  async resolveBirthdayHeight(
    walletId: string,
    accountId: string
  ): Promise<ResolvedBirthdayHeight> {
    const response = await expectSuccess(
      { type: 'RESOLVE_ZCASH_BIRTHDAY_HEIGHT', walletId, accountId },
      'Unable to resolve wallet birthday height'
    )
    const height = requireFiniteNumber(
      response,
      'height',
      'Wallet Background returned an invalid birthday height'
    )
    const source = response.source
    if (source !== 'stored' && source !== 'wasm' && source !== 'fallback' && source !== 'none') {
      throw new Error('Wallet Background returned an invalid birthday source')
    }
    return { height, source }
  },

  async getFeeQuote(): Promise<FeeQuote> {
    const response = await expectSuccess(
      { type: 'GET_ZCASH_FEE_QUOTE' },
      'Unable to get the Zcash network fee'
    )
    return requireFeeQuote(response)
  },

  async estimateTransferFee(input: {
    readonly to: string
    readonly amount: string
    readonly memo?: string
    readonly marginalFeeZats: number
    readonly fundingSource?: FundingSource
    readonly feeQuoteId?: string
    readonly debugRequestId?: string
  }): Promise<QuotedFeeEstimate> {
    const response = await expectSuccess(
      {
        type: 'ESTIMATE_ZCASH_TRANSFER_FEE',
        to: input.to,
        amount: input.amount,
        marginalFeeZats: input.marginalFeeZats,
        ...(input.feeQuoteId === undefined ? {} : { feeQuoteId: input.feeQuoteId }),
        fundingSource: input.fundingSource ?? 'shielded',
        ...(input.debugRequestId === undefined ? {} : { debugRequestId: input.debugRequestId }),
        ...(input.memo === undefined ? {} : { memo: input.memo })
      },
      'Unable to estimate Zcash transfer fee'
    )
    return requireFeeEstimate(response)
  },

  async estimateMaxTransfer(input: {
    readonly to: string
    readonly memo?: string
    readonly marginalFeeZats: number
    readonly fundingSource?: FundingSource
    readonly feeQuoteId?: string
    readonly debugRequestId?: string
  }): Promise<MaxTransferEstimate> {
    const response = await expectSuccess(
      {
        type: 'ESTIMATE_ZCASH_MAX_TRANSFER',
        to: input.to,
        marginalFeeZats: input.marginalFeeZats,
        ...(input.feeQuoteId === undefined ? {} : { feeQuoteId: input.feeQuoteId }),
        fundingSource: input.fundingSource ?? 'shielded',
        ...(input.debugRequestId === undefined ? {} : { debugRequestId: input.debugRequestId }),
        ...(input.memo === undefined ? {} : { memo: input.memo })
      },
      'Unable to estimate maximum Zcash transfer'
    )
    return {
      maxAmountZats: requireString(
        response,
        'maxAmountZats',
        'Wallet Background returned an invalid maximum amount'
      ),
      ...requireFeeEstimate(response)
    }
  },

  async estimateShieldFee(
    marginalFeeZats: number,
    feeQuoteId?: string
  ): Promise<QuotedFeeEstimate> {
    const response = await expectSuccess(
      {
        type: 'ESTIMATE_ZCASH_SHIELD_FEE',
        marginalFeeZats,
        ...(feeQuoteId === undefined ? {} : { feeQuoteId })
      },
      'Unable to estimate shielding fee'
    )
    return requireFeeEstimate(response)
  },

  async waitForAccountReady(timeoutMs = 30_000): Promise<void> {
    await expectSuccess(
      { type: 'WAIT_FOR_ZCASH_ACCOUNT_READY', timeoutMs },
      'Zcash account initialization failed'
    )
  },

  async rotateShieldedReceiveAddress(
    walletId: string,
    accountId: string
  ): Promise<AccountAddresses> {
    const response = await expectSuccess(
      { type: 'ROTATE_ZCASH_SHIELDED_ADDRESS', walletId, accountId },
      'Unable to rotate shielded receive address'
    )
    const addresses = response.addresses
    if (typeof addresses !== 'object' || addresses === null || Array.isArray(addresses)) {
      throw new Error('Wallet Background returned invalid Zcash addresses')
    }
    return addresses as AccountAddresses
  },

  async setShieldedReceiveAddress(
    walletId: string,
    accountId: string,
    shielded: string
  ): Promise<AccountAddresses> {
    const response = await expectSuccess(
      { type: 'SET_ZCASH_SHIELDED_ADDRESS', walletId, accountId, shielded },
      'Unable to select shielded receive address'
    )
    const addresses = response.addresses
    if (typeof addresses !== 'object' || addresses === null || Array.isArray(addresses)) {
      throw new Error('Wallet Background returned invalid Zcash addresses')
    }
    return addresses as AccountAddresses
  },

  requestSync(): void {
    void chrome.runtime.sendMessage({ type: 'BACKGROUND_SYNC' }).catch(() => {})
  },

  async inspectNextAccountHistory(walletId: string): Promise<NextZcashAccountHistoryInspection> {
    const response = await expectSuccess(
      { type: 'INSPECT_NEXT_ZCASH_ACCOUNT_HISTORY', walletId },
      'Unable to inspect Zcash account history'
    )
    const derivationIndex = requireFiniteNumber(
      response,
      'derivationIndex',
      'Wallet Background returned an invalid account index'
    )
    if (!Number.isSafeInteger(derivationIndex) || derivationIndex < 0) {
      throw new Error('Wallet Background returned an invalid account index')
    }
    if (response.status !== 'used' && response.status !== 'unknown') {
      throw new Error('Wallet Background returned an invalid history status')
    }
    const birthdayHeight = response.birthdayHeight
    if (
      birthdayHeight !== undefined &&
      (typeof birthdayHeight !== 'number' ||
        !Number.isSafeInteger(birthdayHeight) ||
        birthdayHeight <= 0)
    ) {
      throw new Error('Wallet Background returned an invalid birthday height')
    }
    return {
      derivationIndex,
      status: response.status,
      ...(birthdayHeight === undefined ? {} : { birthdayHeight })
    }
  },

  async addAccount(
    walletId: string,
    options: {
      readonly accountName?: string
      readonly birthdayHeight?: number
      readonly expectedDerivationIndex?: number
    } = {}
  ): Promise<string> {
    const response = await expectSuccess(
      {
        type: 'ADD_ACCOUNT',
        walletId,
        ...(options.accountName ? { accountName: options.accountName } : {}),
        ...(options.birthdayHeight === undefined ? {} : { birthdayHeight: options.birthdayHeight }),
        ...(options.expectedDerivationIndex === undefined
          ? {}
          : { expectedDerivationIndex: options.expectedDerivationIndex })
      },
      'Account setup failed'
    )
    return requireString(response, 'accountId', 'Wallet Background returned an invalid account')
  },

  async switchAccount(walletId: string, accountId: string): Promise<void> {
    await expectSuccess({ type: 'SWITCH_ACCOUNT', walletId, accountId }, 'Account switch failed')
  },

  async removeAccount(
    walletId: string,
    accountId: string,
    verification?: WalletBackupVerification
  ): Promise<void> {
    await expectSuccess(
      { type: 'REMOVE_ACCOUNT', walletId, accountId, ...(verification ? { verification } : {}) },
      'Account cleanup failed'
    )
  },

  async renameAccount(walletId: string, accountId: string, displayName: string): Promise<void> {
    await expectSuccess(
      { type: 'RENAME_ACCOUNT', walletId, accountId, displayName },
      'Account rename failed'
    )
  },

  async setAccountPinned(walletId: string, accountId: string, pinned: boolean): Promise<void> {
    await expectSuccess(
      { type: 'SET_ACCOUNT_PINNED', walletId, accountId, pinned },
      'Account preference update failed'
    )
  },

  async setAccountHidden(walletId: string, accountId: string, hidden: boolean): Promise<void> {
    await expectSuccess(
      { type: 'SET_ACCOUNT_HIDDEN', walletId, accountId, hidden },
      'Account preference update failed'
    )
  },

  async voting<T>(
    input:
      | { readonly action: 'discoverRounds' }
      | {
          readonly action:
            | 'checkEligibility'
            | 'roundStatus'
            | 'prepareRound'
            | 'roundProposals'
            | 'submitDelegation'
            | 'submitBallot'
            | 'resumeRound'
            | 'clearRound'
          readonly roundId: string
          readonly decisions?: readonly BallotDecision[]
        }
  ): Promise<T> {
    const response = await expectSuccess(
      { type: 'RUN_ZCASH_VOTING', ...input },
      'Zcash voting request failed'
    )
    return response.result as T
  }
})
