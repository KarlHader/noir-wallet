import type { NoirWalletProvider } from './types'
import { ZcashClient } from './chains/zcash/api'
import type { ZcashProvider } from './chains/zcash/types'
import type { BitcoinProvider } from './chains/bitcoin/types'
import type { DashProvider } from './chains/dash/types'
import type { PearlProvider } from './chains/pearl/types'
import type { QuantusProvider } from './chains/quantus/types'
import type { EvmProvider } from './chains/evm/types'
import type { SolanaProvider } from './chains/solana/types'
import type { NearProvider } from './chains/near/types'
import type { StarknetProvider } from './chains/starknet/types'
import type { MultichainProvider, MultichainRequestArguments } from './chains/multichain/types'

interface RawNoirWallet {
  isNoirWallet: true
  version?: string
  request?: <T = unknown>(args: MultichainRequestArguments) => Promise<T>
  multichain?: MultichainProvider
  zcash: ZcashProvider
  ethereum?: EvmProvider
  bitcoin?: BitcoinProvider
  dash?: DashProvider
  pearl?: PearlProvider
  quantus?: QuantusProvider
  solana?: SolanaProvider
  near?: NearProvider
  starknet?: StarknetProvider
}

function isRawNoirWallet(value: unknown): value is RawNoirWallet {
  if (!value || typeof value !== 'object') return false
  const wallet = value as Partial<RawNoirWallet>
  return (
    wallet.isNoirWallet === true &&
    !!wallet.zcash &&
    typeof wallet.zcash.request === 'function' &&
    typeof wallet.zcash.on === 'function'
  )
}

export function getNoirWallet(): NoirWalletProvider | null {
  if (typeof window === 'undefined') return null

  const rawWallet = (window as Window & { noirwallet?: unknown }).noirwallet
  if (!isRawNoirWallet(rawWallet)) return null

  return {
    isNoirWallet: rawWallet.isNoirWallet,
    version: rawWallet.version,
    ...(rawWallet.request ? { request: rawWallet.request.bind(rawWallet) } : {}),
    ...(rawWallet.multichain ? { multichain: rawWallet.multichain } : {}),
    zcash: new ZcashClient(rawWallet.zcash),
    ...(rawWallet.ethereum ? { ethereum: rawWallet.ethereum } : {}),
    ...(rawWallet.bitcoin ? { bitcoin: rawWallet.bitcoin } : {}),
    ...(rawWallet.dash ? { dash: rawWallet.dash } : {}),
    ...(rawWallet.pearl ? { pearl: rawWallet.pearl } : {}),
    ...(rawWallet.quantus ? { quantus: rawWallet.quantus } : {}),
    ...(rawWallet.solana ? { solana: rawWallet.solana } : {}),
    ...(rawWallet.near ? { near: rawWallet.near } : {}),
    ...(rawWallet.starknet ? { starknet: rawWallet.starknet } : {})
  }
}

export function isNoirWalletInstalled(): boolean {
  return getNoirWallet() !== null
}
