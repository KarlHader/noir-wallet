import type { MultichainProvider } from '../chains/multichain/types'
import type {
  PublicAccount,
  PublicAssets,
  PublicTransaction,
  SendPublicTransactionParams
} from '../chains/zcash/types'

export const PUBLIC_SESSION_METHODS = Object.freeze([
  'noir_selectPublicAccount',
  'noir_getPublicAccount',
  'noir_getPublicAssets',
  'noir_activatePublicAccount',
  'noir_sendPublicTransaction',
  'noir_getPublicTransaction',
  'noir_getPublicKey',
  'noir_signMessage'
] as const)

export interface PublicSigningIdentity {
  pubkey: string
  address: string
  signingMode: PublicAccount['signingMode']
}

export interface PublicAccountSelection {
  scope: string
  account: PublicAccount
}

export interface PublicMessageSignature extends PublicSigningIdentity {
  signature: string
}

/** Public operations bound to one authorized CAIP-25 chain scope. */
export class NoirPublicClient {
  constructor(
    private readonly provider: MultichainProvider,
    readonly scope: string
  ) {
    if (
      !/^eip155:[1-9][0-9]*$/.test(scope) &&
      scope !== 'bip122:00040fe8ec8471911baa1db1266ea15d' &&
      scope !== 'bip122:05a60a92d99d85997cce3b87616c089f'
    ) {
      throw new TypeError('Public requires an EVM or Zcash chain scope.')
    }
  }

  private invoke<T>(
    method: (typeof PUBLIC_SESSION_METHODS)[number],
    params?: readonly unknown[]
  ): Promise<T> {
    return this.provider.invokeMethod<T>({
      scope: this.scope,
      request: { method, ...(params === undefined ? {} : { params }) }
    })
  }

  selectPublicAccount(): Promise<PublicAccountSelection> {
    return this.invoke('noir_selectPublicAccount')
  }

  getPublicAccount(): Promise<PublicAccount> {
    return this.invoke('noir_getPublicAccount')
  }

  getPublicAssets(): Promise<PublicAssets> {
    return this.invoke('noir_getPublicAssets')
  }

  activatePublicAccount(): Promise<PublicAccount> {
    return this.invoke('noir_activatePublicAccount')
  }

  sendPublicTransaction(params: SendPublicTransactionParams): Promise<PublicTransaction> {
    return this.invoke('noir_sendPublicTransaction', [params])
  }

  getPublicTransaction(operationId: string): Promise<PublicTransaction | null> {
    return this.invoke('noir_getPublicTransaction', [operationId])
  }

  getPublicKey(): Promise<PublicSigningIdentity> {
    return this.invoke('noir_getPublicKey')
  }

  signMessage(message: string): Promise<PublicMessageSignature> {
    return this.invoke('noir_signMessage', [message])
  }
}
