import type { ChainAccount } from '@/core/accounts/domain'
import { parseNearAccountId } from '@/core/chains/near'
import { supportsNearPrivateExecution } from '@/core/chains/near/execution-capability'
import { describeNearPrivateSendRoute } from '@/popup/services/near-send-routing'
import type { KeyDomainSource } from '@/core/keyring/domain'
import { parseNearIntentsTransactionBinding } from '@/core/transactions/domain'
import type {
  NearTransferOrchestrator,
  PreparedNearTransferApproval
} from '@/infrastructure/chains/near'
import {
  BackgroundNativeTransferController,
  projectNativeTransferReview,
  type ActiveNativeTransferContext,
  type BackgroundNativeTransferReview,
  type NativeTransferControllerOptions
} from './native-transfer-controller'
import { accountContextTransition } from './account-context-transition'

export interface ActiveNearTransferContext extends ActiveNativeTransferContext {
  readonly publicKey: string
}

type PrepareInput = Parameters<NearTransferOrchestrator['prepare']>[0]

export type BackgroundNearTransferControllerOptions = NativeTransferControllerOptions<
  ActiveNearTransferContext,
  PrepareInput,
  PreparedNearTransferApproval
> & {
  readonly deriveNearPea?: (
    keyDomainId: ChainAccount['scope']['keyDomainId'],
    accountIndex: number
  ) => Promise<Readonly<{ readonly address: string }>>
}

export interface BackgroundNearTransferReview extends BackgroundNativeTransferReview {
  readonly debit: PreparedNearTransferApproval['debit']
}

interface NearPrivateSendIntent {
  readonly kind: 'near-private-send'
  readonly source: 'main' | 'incognito'
  readonly assetId: string
  readonly amountRaw: string
  readonly recipient: string
  readonly slippageTolerance: number
  readonly deadline: string
  readonly quote: unknown
}

interface NearIntentsDepositIntent {
  readonly kind: 'intents-deposit'
  readonly assetId: string
  readonly recipient: string
  readonly amountRaw: string
  readonly memo: string
}

const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNearPrivateSendIntent(value: unknown): value is NearPrivateSendIntent {
  if (!isPlainRecord(value)) return false
  const keys = [
    'kind',
    'source',
    'assetId',
    'amountRaw',
    'recipient',
    'slippageTolerance',
    'deadline',
    'quote'
  ]
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    value.kind === 'near-private-send' &&
    (value.source === 'main' || value.source === 'incognito') &&
    typeof value.assetId === 'string' &&
    typeof value.amountRaw === 'string' &&
    typeof value.recipient === 'string' &&
    typeof value.deadline === 'string' &&
    Number.isSafeInteger(value.slippageTolerance)
  )
}

function parseIntentsDepositIntent(value: unknown): NearIntentsDepositIntent | null {
  if (!isPlainRecord(value) || value.kind !== 'intents-deposit') return null
  const keys = ['kind', 'assetId', 'recipient', 'amountRaw', 'memo']
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) ||
    typeof value.assetId !== 'string' ||
    typeof value.recipient !== 'string' ||
    typeof value.amountRaw !== 'string' ||
    typeof value.memo !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.amountRaw) ||
    BigInt(value.amountRaw) > MAXIMUM_U128 ||
    value.memo.length === 0 ||
    value.memo.length > 2048 ||
    !value.assetId.endsWith('/nep141:wrap.near')
  ) {
    throw new Error('Invalid NEAR transfer intent')
  }
  return Object.freeze({
    kind: 'intents-deposit',
    assetId: value.assetId,
    recipient: parseNearAccountId(value.recipient),
    amountRaw: value.amountRaw,
    memo: value.memo
  })
}

function nearPrivateKeySource(
  source: KeyDomainSource
): 'software' | 'imported' | 'hardware' | null {
  if (source.kind === 'software') return 'software'
  if (source.kind === 'hardware') return 'hardware'
  if (source.kind === 'private-key') return 'imported'
  return null
}

function toBackgroundReview(value: PreparedNearTransferApproval): BackgroundNearTransferReview {
  const { graph, review } = projectNativeTransferReview(value)
  return Object.freeze({ graph, debit: value.debit, review })
}

export class BackgroundNearTransferController extends BackgroundNativeTransferController<
  ActiveNearTransferContext,
  PrepareInput,
  PreparedNearTransferApproval,
  BackgroundNearTransferReview
> {
  constructor(private readonly nearOptions: BackgroundNearTransferControllerOptions) {
    super(nearOptions, {
      family: 'near',
      maximumAmount: MAXIMUM_U128,
      parseRecipient: parseNearAccountId,
      toPrepareInput(context, intent, nearIntentsBinding) {
        const { chainAccount, accountIndex, publicKey } = context
        const base = {
          chainAccount,
          accountIndex,
          publicKey,
          receiverId: intent.recipient,
          ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding })
        }
        return intent.assetId === `${chainAccount.scope.chainId}/slip44:397`
          ? { ...base, depositYocto: intent.amountRaw }
          : { ...base, assetId: intent.assetId, amountRaw: intent.amountRaw }
      },
      toReview: toBackgroundReview
    })
  }

  override async prepare(
    intentValue: unknown,
    nearIntentsBindingValue?: unknown
  ): Promise<BackgroundNearTransferReview> {
    if (isNearPrivateSendIntent(intentValue)) {
      if (nearIntentsBindingValue !== undefined) {
        throw new Error('The private transfer could not be prepared.')
      }
      return this.preparePrivateSend(intentValue)
    }
    const intentsDeposit = parseIntentsDepositIntent(intentValue)
    if (intentsDeposit) return this.prepareIntentsDeposit(intentsDeposit, nearIntentsBindingValue)
    return super.prepare(intentValue, nearIntentsBindingValue)
  }

  private async prepareIntentsDeposit(
    intent: NearIntentsDepositIntent,
    nearIntentsBindingValue: unknown
  ): Promise<BackgroundNearTransferReview> {
    const nearIntentsBinding =
      nearIntentsBindingValue === undefined
        ? undefined
        : parseNearIntentsTransactionBinding(nearIntentsBindingValue)
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireNearContext()
      if (!intent.assetId.startsWith(`${context.chainAccount.scope.chainId}/`)) {
        throw new Error('NEAR transfer asset does not match the active network')
      }
      return toBackgroundReview(
        await this.nearOptions.orchestrator.prepare({
          chainAccount: context.chainAccount,
          accountIndex: context.accountIndex,
          publicKey: context.publicKey,
          receiverId: intent.recipient,
          ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding }),
          kind: 'intents-deposit',
          amountRaw: intent.amountRaw,
          memo: intent.memo
        })
      )
    })
  }

  private async preparePrivateSend(
    intent: NearPrivateSendIntent
  ): Promise<BackgroundNearTransferReview> {
    return accountContextTransition.runActiveOperation(async () => {
      const context = await this.requireNearContext()
      if (context.chainAccount.identity.kind !== 'account-identifier') {
        throw new Error('The private transfer could not be prepared.')
      }
      const keySource = nearPrivateKeySource(context.keyDomainSource)
      if (keySource === null) throw new Error('The private transfer could not be prepared.')
      let peaImplicitAccountId: string | null = null
      if (
        supportsNearPrivateExecution(
          context.keyDomainSource.kind === 'private-key'
            ? {
                kind: 'private-key',
                chainFamily: context.keyDomainSource.chainFamily,
                accountIndex: context.accountIndex
              }
            : { kind: context.keyDomainSource.kind }
        ) &&
        this.nearOptions.deriveNearPea
      ) {
        try {
          peaImplicitAccountId = (
            await this.nearOptions.deriveNearPea(
              context.chainAccount.scope.keyDomainId,
              context.accountIndex
            )
          ).address
        } catch {
          peaImplicitAccountId = null
        }
      }
      const described = describeNearPrivateSendRoute({
        chainId: context.chainAccount.scope.chainId,
        source: intent.source,
        assetId: intent.assetId,
        amountRaw: intent.amountRaw,
        recipient: intent.recipient,
        slippageTolerance: intent.slippageTolerance,
        deadline: intent.deadline,
        account: {
          accountIndex: context.accountIndex,
          keySource,
          mainAccountId: context.chainAccount.identity.value,
          peaImplicitAccountId
        },
        quote: intent.quote
      })
      if (!described.ok || described.phase !== 'intents-deposit') {
        throw new Error(
          described.ok ? 'The private transfer could not be prepared.' : described.message
        )
      }
      return toBackgroundReview(
        await this.nearOptions.orchestrator.prepare({
          chainAccount: context.chainAccount,
          accountIndex: context.accountIndex,
          publicKey: context.publicKey,
          receiverId: described.intentsDeposit.depositAddress,
          kind: 'intents-deposit',
          amountRaw: described.intentsDeposit.amountRaw,
          signerId: described.signing.signerId,
          signingKind: described.signing.kind
        })
      )
    })
  }

  private async requireNearContext(): Promise<ActiveNearTransferContext> {
    const context = await this.nearOptions.loadActiveContext()
    if (!context) throw new Error('The active Account has no NEAR ChainAccount')
    const { keyDomainSource } = context
    if (
      (keyDomainSource.kind === 'hardware' &&
        (keyDomainSource.vendor !== 'ledger' || !keyDomainSource.capabilities.includes('near'))) ||
      (keyDomainSource.kind === 'private-key' && keyDomainSource.chainFamily !== 'near')
    ) {
      throw new Error('The active key domain cannot sign NEAR transactions')
    }
    return context
  }
}
