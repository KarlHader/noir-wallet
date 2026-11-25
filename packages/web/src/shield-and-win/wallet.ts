import { utf8ToHex } from './claim'

export interface NoirEthereumProvider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

export interface NoirWallet {
  readonly isNoirWallet?: boolean
  readonly ethereum?: NoirEthereumProvider
}

declare global {
  interface Window {
    noirwallet?: NoirWallet
  }
}

const REJECTION_MESSAGE = 'The request was rejected in Noir Wallet.'
const SECRET_MATERIAL = /0x[0-9a-fA-F]{64,}|[0-9a-fA-F]{128,}/

export function detectNoirWallet(): NoirEthereumProvider | null {
  return installedWallet()?.ethereum ?? null
}

export async function readAccounts(provider: NoirEthereumProvider): Promise<string | null> {
  const accounts = await provider.request({ method: 'eth_accounts' })
  return firstAccount(accounts)
}

export async function revokeAccount(provider: NoirEthereumProvider): Promise<void> {
  await provider.request({
    method: 'wallet_revokePermissions',
    params: [{ eth_accounts: {} }]
  })
}

export async function requestAccount(provider: NoirEthereumProvider): Promise<string> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  const account = firstAccount(accounts)
  if (account === null || account.length === 0) {
    throw new Error('Noir Wallet did not return an account.')
  }
  return account
}

export async function signClaim(
  provider: NoirEthereumProvider,
  address: string,
  message: string
): Promise<string> {
  const signature = await provider.request({
    method: 'personal_sign',
    params: [utf8ToHex(message), address]
  })
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 256) {
    throw new Error('Noir Wallet did not return a signature.')
  }
  return signature
}

export function subscribeAccounts(
  provider: NoirEthereumProvider,
  listener: (account: string | null) => void
): () => void {
  if (typeof provider.on !== 'function' || typeof provider.removeListener !== 'function') {
    return () => undefined
  }
  const on = provider.on
  const remove = provider.removeListener
  const handler = (accounts: unknown) => {
    listener(firstAccount(accounts))
  }
  on.call(provider, 'accountsChanged', handler)
  let active = true
  return () => {
    if (!active) return
    active = false
    remove.call(provider, 'accountsChanged', handler)
  }
}

export function walletErrorMessage(error: unknown): string {
  if (readCode(error) === 4001) return REJECTION_MESSAGE
  const message = readMessage(error)
  if (message !== null && isDisplayableWalletMessage(message)) return message
  return 'Noir Wallet could not complete this request.'
}

function installedWallet(): NoirWallet | null {
  const host = globalThis as typeof globalThis & { noirwallet?: NoirWallet }
  const wallet = host.noirwallet
  if (!wallet?.isNoirWallet || typeof wallet.ethereum?.request !== 'function') return null
  return wallet
}

function firstAccount(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== 'string') return null
  return value[0]
}

function readCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'number' && Number.isInteger(error.code) ? error.code : null
}

function readMessage(error: unknown): string | null {
  if (typeof error === 'string') return error.length > 0 ? error : null
  if (typeof error !== 'object' || error === null || !('message' in error)) return null
  return typeof error.message === 'string' && error.message.length > 0 ? error.message : null
}

function isDisplayableWalletMessage(message: string): boolean {
  const trimmed = message.trim()
  if (trimmed.length === 0 || trimmed.length > 300) return false
  if (SECRET_MATERIAL.test(trimmed) || looksLikeSeed(trimmed)) return false
  return true
}

function looksLikeSeed(message: string): boolean {
  const words = message.trim().split(/\s+/)
  if (words.length !== 12 && words.length !== 24) return false
  return words.every(word => /^[a-z]+$/.test(word))
}
