import type { TransactionAccountScope } from '@/core/transactions/domain'
import type { DashTransferOrchestrator, DashTransferSubmission } from './dash-transfer-orchestrator'

/**
 * Rebroadcasts a persisted signed Dash transaction.
 * Recovery never asks the signer to produce another signature.
 */
export class DashTransactionRecovery {
  constructor(
    private readonly orchestrator: Pick<
      DashTransferOrchestrator,
      'listSignedPending' | 'resumeBroadcast'
    >
  ) {}

  async recoverSignedBroadcasts(
    scope?: TransactionAccountScope
  ): Promise<readonly DashTransferSubmission[]> {
    const pending = await this.orchestrator.listSignedPending()
    const selected = scope
      ? pending.filter(
          candidate =>
            candidate.scope.keyDomainId === scope.keyDomainId &&
            candidate.scope.accountId === scope.accountId
        )
      : pending
    const results: DashTransferSubmission[] = []
    for (const candidate of selected) {
      results.push(
        await this.orchestrator.resumeBroadcast({
          scope: candidate.scope,
          transactionId: candidate.transactionId
        })
      )
    }
    return Object.freeze(results)
  }
}
