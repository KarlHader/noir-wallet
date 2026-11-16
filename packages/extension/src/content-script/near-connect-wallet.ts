import { NOIR_WALLET_PROVIDER_ICON, NOIR_WALLET_PROVIDER_NAME } from './provider-brand'

interface NearConnectAccount {
  readonly accountId: string
  readonly publicKey?: string
}

interface NearConnectSignedMessage {
  readonly accountId: string
  readonly publicKey: string
  readonly signature: string
  readonly state?: string
}

interface RegisterNearConnectWalletOptions {
  readonly network: 'mainnet' | 'testnet'
  readonly version: string
  readonly connect: () => Promise<NearConnectAccount>
  readonly disconnect: () => Promise<void>
  readonly getAccounts: () => Promise<readonly string[]>
  readonly signMessage: (input: {
    readonly message: string
    readonly recipient: string
    readonly nonce: Uint8Array
    readonly signerId?: string
  }) => Promise<NearConnectSignedMessage>
  readonly signAndSendTransaction: (
    input: Readonly<Record<string, unknown>>
  ) => Promise<Readonly<Record<string, unknown>>>
  readonly signAndSendTransactions: (
    input: Readonly<Record<string, unknown>>
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>
}

interface NearConnectNetworkInput {
  readonly network?: 'mainnet' | 'testnet'
}

interface NearConnectSignInInput extends NearConnectNetworkInput {
  readonly addFunctionCallKey?: unknown
}

interface NearConnectMessageInput extends NearConnectNetworkInput {
  readonly message: string
  readonly recipient: string
  readonly nonce: Uint8Array
  readonly signerId?: string
}

function normalizeNearConnectValue(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new TypeError('NEAR transaction parameters are too deeply nested.')
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return Object.freeze(Array.from(value))
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => normalizeNearConnectValue(item, depth + 1)))
  }
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          normalizeNearConnectValue(item, depth + 1)
        ])
      )
    )
  }
  return value
}

function normalizeNearConnectRequest(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeNearConnectValue(item, 1)])
    )
  )
}

function unsupportedNearConnectDelegateAction(): never {
  throw new Error('Noir Wallet does not support NEAR delegate actions.')
}

function assertNetwork(
  requested: 'mainnet' | 'testnet' | undefined,
  active: 'mainnet' | 'testnet'
): void {
  if (requested !== undefined && requested !== active) {
    throw new Error(`Noir Wallet is currently using NEAR ${active}.`)
  }
}

export function registerNearConnectWallet(options: RegisterNearConnectWalletOptions): void {
  const signIn = async (input: NearConnectSignInInput = {}) => {
    assertNetwork(input.network, options.network)
    if (input.addFunctionCallKey !== undefined) {
      throw new Error('Noir Wallet does not add a function-call key during NEAR connection.')
    }
    return Object.freeze([Object.freeze(await options.connect())])
  }

  const wallet = Object.freeze({
    manifest: Object.freeze({
      id: 'noir-wallet',
      platform: Object.freeze(['chrome']),
      name: NOIR_WALLET_PROVIDER_NAME,
      icon: NOIR_WALLET_PROVIDER_ICON,
      description: 'Privacy-first multichain wallet with native NEAR account support.',
      website: 'https://zknoir.com',
      version: options.version,
      executor: '',
      type: 'injected',
      permissions: Object.freeze({}),
      features: Object.freeze({
        signMessage: true,
        signTransaction: false,
        signAndSendTransaction: true,
        signAndSendTransactions: true,
        signInWithoutAddKey: true,
        signInAndSignMessage: true,
        signInWithFunctionCallKey: false,
        signDelegateActions: false,
        mainnet: options.network === 'mainnet',
        testnet: options.network === 'testnet'
      })
    }),
    signIn,
    async signInAndSignMessage(input: {
      readonly network?: 'mainnet' | 'testnet'
      readonly addFunctionCallKey?: unknown
      readonly messageParams: Omit<NearConnectMessageInput, 'network' | 'signerId'>
    }) {
      const [account] = await signIn(input)
      const signedMessage = await options.signMessage({
        ...input.messageParams,
        signerId: account.accountId
      })
      return Object.freeze([Object.freeze({ ...account, signedMessage })])
    },
    async signOut(input: NearConnectNetworkInput = {}) {
      assertNetwork(input.network, options.network)
      await options.disconnect()
    },
    async getAccounts(input: NearConnectNetworkInput = {}) {
      assertNetwork(input.network, options.network)
      const accounts = await options.getAccounts()
      return Object.freeze(accounts.map(accountId => Object.freeze({ accountId })))
    },
    async signAndSendTransaction(input: NearConnectNetworkInput & Record<string, unknown>) {
      assertNetwork(input.network, options.network)
      const { network: _network, ...transaction } = input
      return options.signAndSendTransaction(normalizeNearConnectRequest(transaction))
    },
    async signAndSendTransactions(input: NearConnectNetworkInput & Record<string, unknown>) {
      assertNetwork(input.network, options.network)
      const { network: _network, ...request } = input
      return options.signAndSendTransactions(normalizeNearConnectRequest(request))
    },
    async signMessage(input: NearConnectMessageInput) {
      assertNetwork(input.network, options.network)
      if (!(input.nonce instanceof Uint8Array)) {
        throw new TypeError('NEAR message nonce must be a Uint8Array.')
      }
      const accounts = await options.getAccounts()
      if (input.signerId !== undefined && !accounts.includes(input.signerId)) {
        throw new Error('The requested NEAR signer is not authorized.')
      }
      return options.signMessage(input)
    },
    signDelegateActions: unsupportedNearConnectDelegateAction
  })

  const announce = () => {
    window.dispatchEvent(new CustomEvent('near-wallet-injected', { detail: wallet }))
  }
  window.addEventListener('near-selector-ready', announce)
}
