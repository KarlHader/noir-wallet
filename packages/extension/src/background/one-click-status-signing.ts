import {
  getEvmNetworkConfigs,
  getNearNetworkConfig,
  getSolanaNetworkConfig
} from '@/config/networks'
import { SIGNING_ACCOUNT_INDEX } from '@/config/wallet'
import { parseZcashAddress } from '@/core/address-book/address-book'
import { supportsEvmPrivateExecution } from '@/core/chains/evm'
import { getBitcoinChainId } from '@/core/chains/registry'
import { readActiveStorageV2Snapshot } from '@/core/keyring/application/active-storage-v2-snapshot'
import type { KeyDomainId } from '@/core/keyring/domain'
import type { PreparedSigningCommand, SigningCommandId, SigningResult } from '@/core/keyring/ports'
import type { OneClickViewer } from '@/core/services/near-intents/one-click-order'
import { isRetryableWalletRpcError } from '@/core/zcash/wallet-rpc-errors'
import { detectBitcoinAddressType } from '@/infrastructure/chains/bitcoin/bitcoin-transaction-model'
import { parseEvmAccountBinding } from '@/infrastructure/chains/evm/evm-account'
import { BitcoinMultichainSigningClient } from '@/infrastructure/keyring/multichain/bitcoin-signing-client'
import { EvmMultichainSigningClient } from '@/infrastructure/keyring/multichain/evm-signing-client'
import { NearMultichainSigningClient } from '@/infrastructure/keyring/multichain/near-signing-client'
import { SolanaMultichainSigningClient } from '@/infrastructure/keyring/multichain/solana-signing-client'
import { IndexedDbStorageV2Repository } from '@/infrastructure/persistence/repositories'
import { DEFAULT_NETWORK } from '@/lib/runtime-network'
import { readWalletMetadata, withUndeletedWalletAccountMetadata } from '@/lib/wallet-metadata-storage'
import { credentialSession } from './credential-session'
import type {
  OneClickAccount,
  OneClickChallenge,
  OneClickTokenScope
} from '@/core/services/near-intents/one-click-status-client'

const storage = new IndexedDbStorageV2Repository()
const evmSigner = new EvmMultichainSigningClient({ credentials: credentialSession })
const nearSigner = new NearMultichainSigningClient({ credentials: credentialSession })
const solanaSigner = new SolanaMultichainSigningClient({ credentials: credentialSession })
const bitcoinSigner = new BitcoinMultichainSigningClient({ credentials: credentialSession })

export async function loadOneClickWallet(scope: OneClickAccount) {
  const snapshot = await readWalletMetadata()
  if (snapshot?.state.currentNetwork !== scope.network) return null
  const wallet = snapshot.state.wallets.find(candidate => candidate.id === scope.walletId)
  const account = wallet?.accounts.find(candidate => candidate.id === scope.accountId)
  return wallet && account ? { wallet, account } : null
}

export async function hasOneClickWalletAccount(scope: OneClickAccount): Promise<boolean> {
  if (scope.network !== DEFAULT_NETWORK) return false
  if (await loadOneClickWallet(scope)) return true
  return withUndeletedWalletAccountMetadata(
    scope.walletId,
    scope.accountId,
    scope.network,
    async () => {
      const snapshot = await readActiveStorageV2Snapshot(storage)
      return Boolean(
        snapshot?.keyDomains.some(wallet => wallet.id === scope.walletId) &&
        snapshot.accounts.some(
          account => account.id === scope.accountId && account.keyDomainId === scope.walletId
        )
      )
    }
  )
}

function zcashP2pkh(address: string, scope: OneClickAccount): boolean {
  try {
    return parseZcashAddress(address, scope.network).scheme === 'zcash-transparent-p2pkh'
  } catch {
    return false
  }
}

export async function resolveZcashOneClickViewer(
  scope: OneClickAccount,
  refundTo: string,
  fundingSource: 'transparent' | 'shielded'
): Promise<OneClickViewer | undefined> {
  if (fundingSource === 'transparent') {
    return zcashP2pkh(refundTo, scope)
      ? { chainFamily: 'zcash', walletAddress: refundTo, signingMode: 'transparent' }
      : undefined
  }
  const owner = await loadOneClickWallet(scope)
  if (!owner || owner.wallet.keySource === 'ledger' || owner.wallet.keySource === 'keystone') {
    return undefined
  }
  const { withTxSyncPause } = await import('./sync-scheduler')
  const { backgroundZcashWalletRuntime } = await import('./zcash-wallet-runtime')
  const identity = await withTxSyncPause(scope.walletId, async () => {
    await credentialSession.getCredentialBinding(scope.walletId)
    const core = await backgroundZcashWalletRuntime.getWalletCore(scope.walletId, scope.accountId)
    return core.getPublicKey(SIGNING_ACCOUNT_INDEX)
  })
  if (!zcashP2pkh(identity.address, scope))
    throw new Error('Zcash 1Click signing address is invalid')
  return { chainFamily: 'zcash', walletAddress: identity.address, signingMode: 'derived' }
}

async function resolveZcashSigner(scope: OneClickTokenScope) {
  const owner = await loadOneClickWallet(scope)
  if (!owner || owner.wallet.keySource === 'ledger' || owner.wallet.keySource === 'keystone')
    return null
  const addresses = owner.account.networkAddresses?.[scope.network] ?? owner.account.addresses
  const derived = scope.viewer.signingMode === 'derived'
  if (
    !zcashP2pkh(scope.viewer.walletAddress, scope) ||
    (!derived && addresses.transparent !== scope.viewer.walletAddress)
  ) {
    return null
  }
  const accountIndex = derived ? SIGNING_ACCOUNT_INDEX : owner.account.derivationIndex
  const addressIndex = derived ? undefined : addresses.transparentAddressIndex
  return async (challenge: OneClickChallenge) => {
    const { WalletSyncNotIdleError, withTxSyncPause } = await import('./sync-scheduler')
    const { backgroundZcashWalletRuntime } = await import('./zcash-wallet-runtime')
    return withTxSyncPause(
      scope.walletId,
      async () => {
        if (!(await loadOneClickWallet(scope)))
          throw new Error('1Click order wallet is unavailable')
        await credentialSession.getCredentialBinding(scope.walletId)
        const core = await backgroundZcashWalletRuntime.getWalletCore(
          scope.walletId,
          scope.accountId
        )
        const identity = await core.getPublicKey(accountIndex, addressIndex)
        if (identity.address !== scope.viewer.walletAddress)
          throw new Error('Wrong 1Click Zcash signer')
        if (Date.now() >= challenge.expiresAt) throw new Error('1Click signing challenge expired')
        const signed = await core.signMessage(challenge.message, accountIndex, addressIndex)
        if (signed.address !== scope.viewer.walletAddress)
          throw new Error('Wrong 1Click Zcash signer')
        return { signature: signed.signature }
      },
      Math.min(20_000, challenge.expiresAt - Date.now())
    ).catch(error => {
      if (
        error instanceof WalletSyncNotIdleError ||
        (error instanceof Error && isRetryableWalletRpcError(error.message))
      )
        return null
      throw error
    })
  }
}

async function resolveEvmSigner(scope: OneClickTokenScope) {
  const expected = scope.viewer.walletAddress.toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(expected)) return null
  const snapshot = await readActiveStorageV2Snapshot(storage)
  if (!snapshot) return null
  const keyDomain = snapshot.keyDomains.find(candidate => candidate.id === scope.walletId)
  if (!keyDomain || !supportsEvmPrivateExecution(keyDomain.source)) return null
  const networkChains = new Set<string>(
    getEvmNetworkConfigs(scope.network).map(chain => chain.chainId)
  )
  const candidates = snapshot.chainAccounts.filter(
    candidate =>
      candidate.scope.keyDomainId === scope.walletId &&
      candidate.scope.accountId === scope.accountId &&
      networkChains.has(candidate.scope.chainId)
  )
  const privateMode = scope.viewer.signingMode === 'private'
  for (const candidate of candidates) {
    const chainId = candidate.scope.chainId
    const binding = parseEvmAccountBinding(candidate, chainId)
    const address = privateMode
      ? (await evmSigner.deriveGlobalPea(keyDomain.id, binding.addressIndex)).address
      : binding.address
    if (address.toLowerCase() !== expected) continue
    return async (challenge: OneClickChallenge) => {
      if (!(await hasOneClickWalletAccount(scope)))
        throw new Error('1Click order wallet is unavailable')
      const prepared = await evmSigner.prepare(keyDomain.id, {
        kind: privateMode ? 'pea-evm-personal-message' : 'evm-personal-message',
        chainId,
        addressIndex: binding.addressIndex,
        message: new TextEncoder().encode(challenge.message)
      })
      let consumed = false
      try {
        if (
          prepared.execution.kind !== 'internal' ||
          prepared.summary.schema !== 'evm.personal-message.v1' ||
          prepared.summary.fields.signer.toLowerCase() !== expected ||
          Date.now() >= Math.min(challenge.expiresAt, prepared.expiresAt) ||
          prepared.summary.review.level === 'blocked'
        ) {
          throw new Error('1Click signing challenge cannot be signed')
        }
        const signed = await evmSigner.confirm(keyDomain.id, prepared.commandId)
        consumed = true
        if (
          signed.kind !== 'signature' ||
          signed.signature.encoding !== 'hex' ||
          signed.address?.toLowerCase() !== expected
        ) {
          throw new Error('Wrong 1Click EVM signer')
        }
        return { signature: signed.signature.value }
      } finally {
        if (!consumed) await evmSigner.cancel(keyDomain.id, prepared.commandId).catch(() => {})
      }
    }
  }
  return null
}

export async function resolveOneClickSigner(scope: OneClickTokenScope) {
  if (!(await credentialSession.getCredentialBinding(scope.walletId).catch(() => null))) return null
  if (scope.viewer.chainFamily === 'evm') return resolveEvmSigner(scope)
  if (scope.viewer.chainFamily === 'zcash') return resolveZcashSigner(scope)
  return resolveNativeSigner(scope)
}

async function resolveNativeSigner(scope: OneClickTokenScope) {
  const { chainFamily, walletAddress } = scope.viewer
  const chain =
    chainFamily === 'btc'
      ? getBitcoinChainId(scope.network)
      : chainFamily === 'near'
        ? getNearNetworkConfig(scope.network).chainId
        : getSolanaNetworkConfig(scope.network).chainId
  const snapshot = await readActiveStorageV2Snapshot(storage)
  const keyDomain = snapshot?.keyDomains.find(candidate => candidate.id === scope.walletId)
  const account = snapshot?.accounts.find(
    candidate => candidate.id === scope.accountId && candidate.keyDomainId === scope.walletId
  )
  const chainAccount = snapshot?.chainAccounts.find(
    candidate =>
      candidate.scope.keyDomainId === scope.walletId &&
      candidate.scope.accountId === scope.accountId &&
      candidate.scope.chainId === chain
  )
  if (!account || !chainAccount || !keyDomain || keyDomain.source.kind === 'hardware') return null
  if (
    chainFamily !== 'btc' &&
    (chainAccount.identity.kind !== 'account-identifier' ||
      chainAccount.identity.value !== walletAddress)
  )
    return null

  const chainId = chainAccount.scope.chainId
  const accountIndex = account.accountIndex
  const key = keyDomain.id
  const btcAddressType =
    chainFamily === 'btc' ? detectBitcoinAddressType(walletAddress, chainId) : undefined
  if (btcAddressType === 'p2pkh' || btcAddressType === 'p2sh-p2wpkh') return null
  return async (challenge: OneClickChallenge): Promise<Record<string, string>> => {
    if (!(await hasOneClickWalletAccount(scope)))
      throw new Error('1Click order wallet is unavailable')
    const message = new TextEncoder().encode(challenge.message)
    if (chainFamily === 'near' && challenge.near) {
      const prepared = await nearSigner.prepare(key, {
        kind: 'near-nep413-message',
        chainId,
        accountIndex,
        request: {
          chainId,
          accountIndex,
          accountId: walletAddress,
          message: challenge.message,
          recipient: challenge.near.recipient,
          nonce: Array.from(challenge.near.nonce),
          state: null,
          callbackUrl: null
        }
      })
      const signature = await confirmNativeOneClickSignature(
        nearSigner,
        key,
        prepared,
        challenge,
        walletAddress,
        'base64'
      )
      return {
        accountId: walletAddress,
        publicKey: signature.publicKey,
        signature: signature.value
      }
    }
    if (chainFamily === 'solana') {
      const prepared = await solanaSigner.prepare(key, {
        kind: 'solana-message',
        chainId,
        accountIndex,
        message
      })
      const signature = await confirmNativeOneClickSignature(
        solanaSigner,
        key,
        prepared,
        challenge,
        walletAddress,
        'utf8'
      )
      return { signature: signature.value }
    }
    if (chainFamily === 'btc' && btcAddressType) {
      const address = snapshot?.addresses.find(
        candidate =>
          candidate.chainAccountId === chainAccount.id && candidate.value === walletAddress
      )
      const path = /\/([01])\/(0|[1-9][0-9]*)$/.exec(address?.derivation?.path ?? '')
      const prepared = await bitcoinSigner.prepare(key, {
        kind: 'bitcoin-bip322-message',
        chainId,
        accountIndex,
        message,
        addressType: btcAddressType,
        change: path?.[1] === '1',
        addressIndex: Number(path?.[2] ?? 0)
      })
      const signature = await confirmNativeOneClickSignature(
        bitcoinSigner,
        key,
        prepared,
        challenge,
        walletAddress,
        'utf8'
      )
      return { signature: signature.value, signatureType: 'bip322-simple' }
    }
    throw new Error('1Click challenge does not match its signing wallet')
  }
}

async function confirmNativeOneClickSignature(
  signer: {
    confirm(key: KeyDomainId, commandId: SigningCommandId): Promise<SigningResult>
    cancel(key: KeyDomainId, commandId: SigningCommandId): Promise<unknown>
  },
  key: KeyDomainId,
  prepared: PreparedSigningCommand,
  challenge: OneClickChallenge,
  address: string,
  encoding: 'base64' | 'utf8'
): Promise<{ value: string; publicKey: string }> {
  let consumed = false
  try {
    const fields = prepared.summary.fields as Readonly<Record<string, unknown>>
    if (
      Date.now() >= Math.min(challenge.expiresAt, prepared.expiresAt) ||
      prepared.summary.review.level === 'blocked' ||
      (fields.signerId ?? fields.signer ?? fields.address) !== address
    ) {
      throw new Error('1Click signing challenge cannot be signed')
    }
    const result = await signer.confirm(key, prepared.commandId)
    consumed = true
    if (
      result.kind !== 'signature' ||
      result.signature.encoding !== encoding ||
      typeof result.signature.value !== 'string' ||
      result.address !== address
    ) {
      throw new Error('Wrong 1Click order status signer')
    }
    return { value: result.signature.value, publicKey: result.publicKey }
  } finally {
    if (!consumed) await signer.cancel(key, prepared.commandId).catch(() => {})
  }
}
