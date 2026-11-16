export interface WalletAccountContext {
  readonly walletId: string
  readonly accountId: string
}

export type AccountContextInvalidation =
  | Readonly<{ mode: 'scope'; scope: WalletAccountContext }>
  | Readonly<{ mode: 'except'; scope: WalletAccountContext }>

export interface AccountContextInvalidator {
  readonly invalidate: (request: AccountContextInvalidation) => Promise<void>
}

interface AccountSwitchOperation<T> {
  readonly readCurrent: () => WalletAccountContext | null
  readonly validateTarget: () => void
  readonly commit: () => Promise<T>
}

function contextsMatch(left: WalletAccountContext | null, right: WalletAccountContext): boolean {
  return left?.walletId === right.walletId && left.accountId === right.accountId
}

export class AccountContextTransitionCoordinator {
  private operation: Promise<void> = Promise.resolve()
  private readonly invalidators = new Set<AccountContextInvalidator>()

  registerInvalidator(invalidator: AccountContextInvalidator): () => void {
    this.invalidators.add(invalidator)
    return () => this.invalidators.delete(invalidator)
  }

  runActiveOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(operation)
  }

  runAccountSwitch<T>(
    target: WalletAccountContext,
    operation: AccountSwitchOperation<T>
  ): Promise<T> {
    return this.enqueue(async () => {
      operation.validateTarget()
      const previous = operation.readCurrent()
      if (!contextsMatch(previous, target) && previous) {
        await this.invalidate(Object.freeze({ mode: 'scope', scope: previous }))
      }
      return operation.commit()
    })
  }

  runScopedMutation<T>(
    scopes: readonly WalletAccountContext[],
    operation: () => Promise<T>
  ): Promise<T> {
    return this.enqueue(async () => {
      const unique = new Map(
        scopes.map(scope => [`${scope.walletId}\u0000${scope.accountId}`, scope])
      )
      for (const scope of unique.values()) {
        await this.invalidate(Object.freeze({ mode: 'scope', scope }))
      }
      return operation()
    })
  }

  invalidateExcept(scope: WalletAccountContext): Promise<void> {
    return this.enqueue(() => this.invalidate(Object.freeze({ mode: 'except', scope })))
  }

  private async invalidate(request: AccountContextInvalidation): Promise<void> {
    for (const invalidator of this.invalidators) {
      await invalidator.invalidate(request)
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.catch(() => {}).then(operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export const accountContextTransition = new AccountContextTransitionCoordinator()
