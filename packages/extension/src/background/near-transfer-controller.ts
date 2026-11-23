import { parseNearAccountId } from '@/core/chains/near'
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

export interface ActiveNearTransferContext extends ActiveNativeTransferContext {
  readonly publicKey: string
}

type PrepareInput = Parameters<NearTransferOrchestrator['prepare']>[0]

export type BackgroundNearTransferControllerOptions = NativeTransferControllerOptions<
  ActiveNearTransferContext,
  PrepareInput,
  PreparedNearTransferApproval
>

export interface BackgroundNearTransferReview extends BackgroundNativeTransferReview {
  readonly debit: PreparedNearTransferApproval['debit']
}

export class BackgroundNearTransferController extends BackgroundNativeTransferController<
  ActiveNearTransferContext,
  PrepareInput,
  PreparedNearTransferApproval,
  BackgroundNearTransferReview
> {
  constructor(options: BackgroundNearTransferControllerOptions) {
    super(options, {
      family: 'near',
      maximumAmount: 340_282_366_920_938_463_463_374_607_431_768_211_455n,
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
      toReview(prepared) {
        const { graph, review } = projectNativeTransferReview(prepared)
        return Object.freeze({ graph, debit: prepared.debit, review })
      }
    })
  }
}
