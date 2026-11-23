import {
  parseSolanaPublicKey,
  type PreparedSolanaTransferApproval,
  type SolanaTransferOrchestrator
} from '@/infrastructure/chains/solana'
import {
  BackgroundNativeTransferController,
  projectNativeTransferReview,
  type ActiveNativeTransferContext,
  type BackgroundNativeTransferReview,
  type NativeTransferControllerOptions
} from './native-transfer-controller'

export type ActiveSolanaTransferContext = ActiveNativeTransferContext
export type BackgroundSolanaTransferReview = BackgroundNativeTransferReview

type PrepareInput = Parameters<SolanaTransferOrchestrator['prepare']>[0]

export type BackgroundSolanaTransferControllerOptions = NativeTransferControllerOptions<
  ActiveSolanaTransferContext,
  PrepareInput,
  PreparedSolanaTransferApproval
>

export class BackgroundSolanaTransferController extends BackgroundNativeTransferController<
  ActiveSolanaTransferContext,
  PrepareInput,
  PreparedSolanaTransferApproval,
  BackgroundSolanaTransferReview
> {
  constructor(options: BackgroundSolanaTransferControllerOptions) {
    super(options, {
      family: 'solana',
      maximumAmount: 18_446_744_073_709_551_615n,
      parseRecipient: parseSolanaPublicKey,
      toPrepareInput(context, intent, nearIntentsBinding) {
        const { chainAccount, accountIndex } = context
        const base = {
          chainAccount,
          accountIndex,
          recipient: intent.recipient,
          ...(nearIntentsBinding === undefined ? {} : { nearIntentsBinding })
        }
        return intent.assetId === `${chainAccount.scope.chainId}/slip44:501`
          ? { ...base, lamports: intent.amountRaw }
          : { ...base, assetId: intent.assetId, amountRaw: intent.amountRaw }
      },
      toReview: projectNativeTransferReview
    })
  }
}
