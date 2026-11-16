import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { parseChainId } from '@/core/chains/registry'
import { SecureStorage } from '@/core/wallet/secure-storage'
import { credentialLifecycle } from './credential-lifecycle'
import { credentialSession } from './credential-session'

export interface ImportPrivateKeyWalletInput {
  readonly privateKey: string
  readonly chainFamily: 'eip155' | 'bip122' | 'solana' | 'near'
  readonly displayName: string
}

export type PreviewPrivateKeyWalletInput = Pick<
  ImportPrivateKeyWalletInput,
  'privateKey' | 'chainFamily'
>

export interface ExportPrivateKeyInput {
  readonly walletId: string
  readonly accountId: string
  readonly chainId: string
  readonly password: string
  readonly bitcoinAddressType?: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'
}

function validateBoundedString(value: string, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function validatePassword(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 1024 * 1024
  ) {
    throw new Error('Invalid password')
  }
  return value
}

export async function importPrivateKeyWallet(input: ImportPrivateKeyWalletInput) {
  if (!(await credentialSession.hasUnlockSession())) {
    throw new Error('Wallet is locked. Please unlock and try again.')
  }
  const password = await credentialSession.getProvisioningPassword()
  const result = await credentialLifecycle.provisionPrivateKey({
    privateKey: validateBoundedString(input.privateKey, 512, 'private key'),
    chainFamily: input.chainFamily,
    displayName: validateBoundedString(input.displayName, 128, 'Wallet name'),
    password,
    network: DEFAULT_NETWORK
  })
  const descriptor = await credentialSession.unlock(password)
  if (!descriptor) throw new Error('Imported Wallet could not join the active session')
  await Promise.all([SecureStorage.resetLoginAttempts(), SecureStorage.saveLastActivityTime()])
  return result
}

export async function previewPrivateKeyWallet(input: PreviewPrivateKeyWalletInput) {
  if (!(await credentialSession.hasUnlockSession())) {
    throw new Error('Wallet is locked. Please unlock and try again.')
  }
  const password = await credentialSession.getProvisioningPassword()
  return credentialLifecycle.previewPrivateKey({
    privateKey: validateBoundedString(input.privateKey, 512, 'private key'),
    chainFamily: input.chainFamily,
    password,
    network: DEFAULT_NETWORK
  })
}

export async function exportPrivateKey(input: ExportPrivateKeyInput) {
  validateBoundedString(input.walletId, 512, 'Wallet ID')
  validateBoundedString(input.accountId, 512, 'Account ID')
  const chainId = parseChainId(input.chainId).id
  const password = validatePassword(input.password)
  const binding = await credentialSession.getCredentialBinding(input.walletId)
  return credentialLifecycle.exportPrivateKey({
    keyDomainId: input.walletId,
    accountId: input.accountId,
    chainId,
    password,
    binding,
    ...(input.bitcoinAddressType === undefined
      ? {}
      : { bitcoinAddressType: input.bitcoinAddressType })
  })
}
