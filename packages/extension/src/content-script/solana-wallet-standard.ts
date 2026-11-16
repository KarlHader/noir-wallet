import { NOIR_WALLET_PROVIDER_ICON, NOIR_WALLET_PROVIDER_NAME } from './provider-brand'

type StandardRequest = (method: string, params?: readonly unknown[]) => Promise<unknown>

interface StandardWalletAccount {
  readonly address: string
  readonly publicKey: Uint8Array
  readonly chains: readonly string[]
  readonly features: readonly string[]
  readonly label: string
}

interface RegisterSolanaWalletStandardOptions {
  readonly chain: string
  readonly request: StandardRequest
  readonly onAccountsChanged: (listener: (accounts: readonly string[]) => void) => void
  readonly onAccountCapabilitiesChanged?: (
    listener: (
      capabilities: readonly { readonly address: string; readonly signMessage: boolean }[]
    ) => void
  ) => void
}

export interface SolanaTransactionOptions {
  readonly preflightCommitment?: 'processed' | 'confirmed' | 'finalized'
  readonly minContextSlot?: number
  readonly commitment?: 'processed' | 'confirmed' | 'finalized'
  readonly skipPreflight?: boolean
  readonly maxRetries?: number
}

const FEATURES = Object.freeze([
  'solana:signAndSendTransaction',
  'solana:signTransaction',
  'solana:signMessage'
])
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function encodeBase58(value: Uint8Array): string {
  if (value.byteLength === 0) throw new Error('Cannot encode empty base58 bytes')
  let number = 0n
  for (const byte of value) number = (number << 8n) | BigInt(byte)
  let encoded = ''
  while (number > 0n) {
    encoded = BASE58_ALPHABET[Number(number % 58n)] + encoded
    number /= 58n
  }
  for (const byte of value) {
    if (byte !== 0) break
    encoded = `1${encoded}`
  }
  return encoded
}

export function decodeBase58(value: string, expectedLength?: number): Uint8Array {
  if (value.length === 0 || value.length > 128) throw new Error('Invalid base58 value')
  let number = 0n
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('Invalid base58 value')
    number = number * 58n + BigInt(index)
  }
  const bytes: number[] = []
  while (number > 0n) {
    bytes.push(Number(number & 0xffn))
    number >>= 8n
  }
  for (const character of value) {
    if (character !== '1') break
    bytes.push(0)
  }
  bytes.reverse()
  const decoded = Uint8Array.from(bytes)
  if (expectedLength !== undefined && decoded.byteLength !== expectedLength) {
    throw new Error('Unexpected base58 byte length')
  }
  return decoded
}

export function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function readAddressList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every(address => typeof address === 'string')) {
    throw new Error('Noir Wallet returned invalid Solana accounts')
  }
  return Object.freeze([...value])
}

export function normalizeSolanaTransactionOptions(
  value: unknown,
  allowSendOptions: boolean
): SolanaTransactionOptions | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Solana transaction options.')
  }
  const allowedKeys = allowSendOptions
    ? ['preflightCommitment', 'minContextSlot', 'commitment', 'skipPreflight', 'maxRetries']
    : ['preflightCommitment', 'minContextSlot']
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new TypeError('Invalid Solana transaction options.')
  }
  const readCommitment = (key: 'preflightCommitment' | 'commitment') => {
    const commitment = Reflect.get(value, key)
    if (
      commitment !== undefined &&
      commitment !== 'processed' &&
      commitment !== 'confirmed' &&
      commitment !== 'finalized'
    ) {
      throw new TypeError('Invalid Solana transaction commitment.')
    }
    return commitment as 'processed' | 'confirmed' | 'finalized' | undefined
  }
  const readInteger = (key: 'minContextSlot' | 'maxRetries') => {
    const number = Reflect.get(value, key)
    if (number !== undefined && (!Number.isSafeInteger(number) || (number as number) < 0)) {
      throw new TypeError(`Invalid Solana ${key}.`)
    }
    return number as number | undefined
  }
  const skipPreflight = Reflect.get(value, 'skipPreflight')
  if (skipPreflight !== undefined && typeof skipPreflight !== 'boolean') {
    throw new TypeError('Invalid Solana skipPreflight option.')
  }
  const preflightCommitment = readCommitment('preflightCommitment')
  const minContextSlot = readInteger('minContextSlot')
  const commitment = allowSendOptions ? readCommitment('commitment') : undefined
  const maxRetries = allowSendOptions ? readInteger('maxRetries') : undefined
  return Object.freeze({
    ...(preflightCommitment === undefined ? {} : { preflightCommitment }),
    ...(minContextSlot === undefined ? {} : { minContextSlot }),
    ...(commitment === undefined ? {} : { commitment }),
    ...(allowSendOptions && skipPreflight !== undefined ? { skipPreflight } : {}),
    ...(maxRetries === undefined ? {} : { maxRetries })
  })
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

export function registerSolanaWalletStandard(options: RegisterSolanaWalletStandardOptions): void {
  let accounts: readonly StandardWalletAccount[] = Object.freeze([])
  let messageCapabilities = new Map<string, boolean>()
  const changeListeners = new Set<
    (properties: { accounts: readonly StandardWalletAccount[] }) => void
  >()

  const setAccounts = (addresses: readonly string[]) => {
    accounts = Object.freeze(
      addresses.map(address =>
        Object.freeze({
          address,
          publicKey: decodeBase58(address, 32),
          chains: Object.freeze([options.chain]),
          features:
            messageCapabilities.get(address) === true
              ? FEATURES
              : Object.freeze(FEATURES.filter(feature => feature !== 'solana:signMessage')),
          label: NOIR_WALLET_PROVIDER_NAME
        })
      )
    )
    for (const listener of [...changeListeners]) listener(Object.freeze({ accounts }))
  }

  options.onAccountCapabilitiesChanged?.(capabilities => {
    messageCapabilities = new Map(capabilities.map(item => [item.address, item.signMessage]))
    setAccounts(accounts.map(account => account.address))
  })

  const assertInputAccount = (value: unknown): StandardWalletAccount => {
    if (!value || typeof value !== 'object' || !('address' in value)) {
      throw new TypeError('A Solana Wallet Standard account is required.')
    }
    const account = accounts.find(candidate => candidate.address === value.address)
    if (!account) throw new Error('The Solana account is not connected.')
    return account
  }

  const readTransactionInput = (value: unknown, allowSendOptions: boolean) => {
    if (!value || typeof value !== 'object')
      throw new TypeError('Invalid Solana transaction input.')
    const account = assertInputAccount(Reflect.get(value, 'account'))
    const transaction = Reflect.get(value, 'transaction')
    const chain = Reflect.get(value, 'chain')
    if (!(transaction instanceof Uint8Array) || (chain !== undefined && chain !== options.chain)) {
      throw new TypeError('Invalid Solana transaction input.')
    }
    const transactionOptions = normalizeSolanaTransactionOptions(
      Reflect.get(value, 'options'),
      allowSendOptions
    )
    return Object.freeze({
      account,
      transaction: new Uint8Array(transaction),
      ...(transactionOptions === undefined ? {} : { options: transactionOptions })
    })
  }

  const wallet = Object.freeze({
    version: '1.0.0',
    name: NOIR_WALLET_PROVIDER_NAME,
    icon: NOIR_WALLET_PROVIDER_ICON,
    chains: Object.freeze([options.chain]),
    get accounts() {
      return accounts
    },
    features: Object.freeze({
      'standard:connect': Object.freeze({
        version: '1.0.0',
        connect: async (input?: { readonly silent?: boolean }) => {
          const value = input?.silent
            ? await options.request('getAccounts')
            : await options.request('requestAccounts')
          setAccounts(readAddressList(value))
          return Object.freeze({ accounts })
        }
      }),
      'standard:disconnect': Object.freeze({
        version: '1.0.0',
        disconnect: async () => {
          await options.request('disconnect')
          setAccounts([])
        }
      }),
      'standard:events': Object.freeze({
        version: '1.0.0',
        on: (
          event: string,
          listener: (properties: { accounts: readonly StandardWalletAccount[] }) => void
        ) => {
          if (event !== 'change' || typeof listener !== 'function') {
            throw new TypeError('Wallet Standard supports only the change event.')
          }
          changeListeners.add(listener)
          return () => changeListeners.delete(listener)
        }
      }),
      'solana:signTransaction': Object.freeze({
        version: '1.0.0',
        supportedTransactionVersions: Object.freeze(['legacy', 0]),
        signTransaction: async (...inputs: readonly unknown[]) => {
          if (inputs.length === 0 || inputs.length > 16)
            throw new TypeError('Invalid Solana batch size.')
          const parsed = inputs.map(input => readTransactionInput(input, false))
          const encoded = parsed.map(input => encodeBase64(input.transaction))
          let value: unknown
          if (parsed.some(input => input.options !== undefined)) {
            const signed = []
            for (const input of parsed) {
              signed.push(
                await options.request('signTransaction', [
                  encodeBase64(input.transaction),
                  ...(input.options === undefined ? [] : [input.options])
                ])
              )
            }
            value = signed
          } else {
            value =
              encoded.length === 1
                ? [await options.request('signTransaction', encoded)]
                : await options.request('signAllTransactions', [encoded])
          }
          if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
            throw new Error('Noir Wallet returned invalid signed transactions')
          }
          return Object.freeze(
            value.map(signedTransaction =>
              Object.freeze({ signedTransaction: decodeBase64(signedTransaction) })
            )
          )
        }
      }),
      'solana:signAndSendTransaction': Object.freeze({
        version: '1.0.0',
        supportedTransactionVersions: Object.freeze(['legacy', 0]),
        signAndSendTransaction: async (...inputs: readonly unknown[]) => {
          if (inputs.length === 0 || inputs.length > 16)
            throw new TypeError('Invalid Solana batch size.')
          const outputs = []
          for (const value of inputs) {
            const input = readTransactionInput(value, true)
            const signature = await options.request('signAndSendTransaction', [
              encodeBase64(input.transaction),
              ...(input.options === undefined ? [] : [input.options])
            ])
            if (typeof signature !== 'string')
              throw new Error('Noir Wallet returned an invalid signature')
            outputs.push(Object.freeze({ signature: decodeBase58(signature, 64) }))
          }
          return Object.freeze(outputs)
        }
      }),
      'solana:signMessage': Object.freeze({
        version: '1.0.0',
        signMessage: async (...inputs: readonly unknown[]) => {
          if (inputs.length === 0 || inputs.length > 16)
            throw new TypeError('Invalid Solana batch size.')
          const messages = inputs.map(value => {
            if (!value || typeof value !== 'object')
              throw new TypeError('Invalid Solana message input.')
            const account = assertInputAccount(Reflect.get(value, 'account'))
            if (!account.features.includes('solana:signMessage'))
              throw new Error('Message signing is not supported by this account.')
            const message = Reflect.get(value, 'message')
            if (!(message instanceof Uint8Array))
              throw new TypeError('Invalid Solana message input.')
            return new Uint8Array(message)
          })
          const outputs = []
          for (const message of messages) {
            const result = await options.request('signMessage', [encodeBase64(message)])
            if (
              !result ||
              typeof result !== 'object' ||
              typeof Reflect.get(result, 'signature') !== 'string'
            ) {
              throw new Error('Noir Wallet returned an invalid message signature')
            }
            outputs.push(
              Object.freeze({
                signedMessage: new Uint8Array(message),
                signature: decodeBase58(Reflect.get(result, 'signature'), 64),
                signatureType: 'ed25519'
              })
            )
          }
          return Object.freeze(outputs)
        }
      })
    })
  })

  options.onAccountsChanged(setAccounts)
  queueMicrotask(() => {
    options
      .request('getAccounts')
      .then(value => setAccounts(readAddressList(value)))
      .catch(() => {})
  })
  registerWallet(wallet)
}
