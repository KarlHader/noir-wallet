export interface CurrentDAppEvmNetworkSelectionContext {
  readonly origin: string
  readonly walletId: string
  readonly accountId: string
  readonly networkMode: string
  readonly activeChainId: string
  readonly authorizationRevision: number
  readonly authorizationSnapshot: string
  readonly unlockEpoch: string
  readonly runtimeKey: string
}

export interface CurrentDAppEvmNetworkState {
  readonly origin: string
  readonly activeChainId: string
  readonly options: readonly Readonly<{
    chainId: string
    displayName: string
    iconChain: string
  }>[]
  readonly selectionContext: CurrentDAppEvmNetworkSelectionContext
}

interface CurrentDAppEvmNetworkOptions {
  readonly read: () => Promise<CurrentDAppEvmNetworkState | null>
  readonly commit: (
    chainId: string,
    context: CurrentDAppEvmNetworkSelectionContext,
    validate: () => Promise<void>
  ) => Promise<void>
}

export class CurrentDAppEvmNetworkCoordinator {
  constructor(private readonly options: CurrentDAppEvmNetworkOptions) {}

  get(): Promise<CurrentDAppEvmNetworkState | null> {
    return this.options.read()
  }

  async set(
    chainId: string,
    context: CurrentDAppEvmNetworkSelectionContext
  ): Promise<CurrentDAppEvmNetworkState> {
    const validate = async () => {
      const current = await this.options.read()
      if (
        !current ||
        JSON.stringify(current.selectionContext) !== JSON.stringify(context) ||
        !current.options.some(option => option.chainId === chainId)
      ) {
        throw new Error('Site or wallet context changed. Select the network again.')
      }
    }
    await validate()
    if (chainId !== context.activeChainId) {
      await this.options.commit(chainId, context, validate)
    }
    const result = await this.options.read()
    if (!result || result.origin !== context.origin || result.activeChainId !== chainId) {
      throw new Error('Site or wallet context changed. Select the network again.')
    }
    return result
  }
}
