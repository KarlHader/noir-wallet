import { NOIR_WALLET_PROVIDER_ICON, NOIR_WALLET_PROVIDER_NAME } from './provider-brand'

const STARKNET_WALLET_STANDARD_CHAINS = Object.freeze([
  'starknet:0x534e5f4d41494e',
  'starknet:0x534e5f5345504f4c4941'
] as const)

const FEATURES = Object.freeze([
  'starknet:walletApi',
  'standard:connect',
  'standard:disconnect',
  'standard:events'
] as const)

type StandardRequest = (
  method: string,
  params?: Readonly<Record<string, unknown>>
) => Promise<unknown>

export interface StarknetWalletApi {
  readonly id: 'noirwallet'
  readonly name: string
  readonly version: string
  readonly icon: string
  request(args: {
    readonly type: string
    readonly params?: Readonly<Record<string, unknown>>
  }): Promise<unknown>
  on(event: string, handler: (data: unknown) => void): void
  off(event: string, handler: (data: unknown) => void): void
}

interface RegisterStarknetWalletStandardOptions {
  readonly version: string
  readonly request: StandardRequest
  readonly onAccountsChanged: (listener: (accounts: readonly string[]) => void) => void
}

function readAddresses(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every(address => typeof address === 'string')) {
    throw new Error('Noir Wallet returned invalid Starknet accounts')
  }
  return Object.freeze([...value])
}

function registerWallet(wallet: Readonly<Record<string, unknown>>): void {
  const callback = ({ register }: { register: (wallet: unknown) => void }) => register(wallet)
  class RegisterWalletEvent extends Event {
    readonly detail = callback

    constructor() {
      super('wallet-standard:register-wallet', {
        bubbles: false,
        cancelable: false,
        composed: false
      })
    }

    override preventDefault(): never {
      throw new Error('preventDefault cannot be called')
    }

    override stopImmediatePropagation(): never {
      throw new Error('stopImmediatePropagation cannot be called')
    }

    override stopPropagation(): never {
      throw new Error('stopPropagation cannot be called')
    }
  }
  window.dispatchEvent(new RegisterWalletEvent())
  window.addEventListener('wallet-standard:app-ready', event => {
    const detail = (event as CustomEvent<unknown>).detail
    if (
      detail &&
      typeof detail === 'object' &&
      'register' in detail &&
      typeof detail.register === 'function'
    ) {
      callback(detail as { register: (wallet: unknown) => void })
    }
  })
}

export function registerStarknetWalletStandard(
  options: RegisterStarknetWalletStandardOptions
): void {
  let accounts: readonly string[] = []
  const changeListeners = new Set<(accounts: readonly string[]) => void>()
  const setAccounts = (next: readonly string[]) => {
    accounts = Object.freeze([...next])
    for (const listener of changeListeners) listener(accounts)
  }
  const walletAccounts = () =>
    Object.freeze(
      accounts.map(address =>
        Object.freeze({
          address,
          publicKey: address,
          chains: STARKNET_WALLET_STANDARD_CHAINS,
          features: FEATURES
        })
      )
    )

  const wallet = Object.freeze({
    version: '1.0.0',
    name: NOIR_WALLET_PROVIDER_NAME,
    icon: NOIR_WALLET_PROVIDER_ICON,
    chains: STARKNET_WALLET_STANDARD_CHAINS,
    get accounts() {
      return walletAccounts()
    },
    features: Object.freeze({
      'starknet:walletApi': Object.freeze({
        version: '0.10.4',
        request: (args: {
          readonly type: string
          readonly params?: Readonly<Record<string, unknown>>
        }) => options.request(args.type, args.params)
      }),
      'standard:connect': Object.freeze({
        version: '1.0.0',
        connect: async () => {
          setAccounts(readAddresses(await options.request('wallet_requestAccounts')))
          return Object.freeze({ accounts: walletAccounts() })
        }
      }),
      'standard:disconnect': Object.freeze({
        version: '1.0.0',
        disconnect: async () => {
          await options.request('wallet_disconnect')
          setAccounts([])
        }
      }),
      'standard:events': Object.freeze({
        version: '1.0.0',
        on: (event: string, listener: (accounts: readonly string[]) => void) => {
          if (event !== 'change' || typeof listener !== 'function') return () => undefined
          changeListeners.add(listener)
          return () => changeListeners.delete(listener)
        }
      })
    })
  })

  options.onAccountsChanged(setAccounts)
  queueMicrotask(() => {
    options
      .request('wallet_requestAccounts', { silent_mode: true })
      .then(value => setAccounts(readAddresses(value)))
      .catch(() => {})
  })
  registerWallet(wallet)
}
