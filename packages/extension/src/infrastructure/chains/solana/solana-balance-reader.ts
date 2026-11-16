import { getSolanaNetworkConfigs } from '@/config/networks'
import { parseChainId } from '@/core/chains/registry'

import type {
  SolanaReadRpc,
  SolanaTokenAccountBalance,
  SolanaTokenProgram
} from './solana-rpc-client'
import { parseSolanaPublicKey } from './solana-rpc-client'

const MAXIMUM_TOKEN_ASSETS = 2_048
const MAXIMUM_RAW_AMOUNT_DIGITS = 128

export interface SolanaNativeBalanceSnapshot {
  readonly assetId: string
  readonly amountRaw: string
  readonly contextSlot: number
}

export interface SolanaTokenBalanceSnapshot {
  readonly assetId: string
  readonly mint: string
  readonly program: SolanaTokenProgram
  readonly amountRaw: string
  readonly decimals: number
  readonly accountAddresses: readonly string[]
  readonly contextSlot: number
}

export interface SolanaBalanceReadModel {
  readonly chainId: string
  readonly address: string
  readonly native: SolanaNativeBalanceSnapshot
  readonly tokens: readonly SolanaTokenBalanceSnapshot[]
  readonly updatedAt: number
}

export interface ReadSolanaBalancesInput {
  readonly chainId: string
  readonly address: string
  readonly rpc: Pick<
    SolanaReadRpc,
    'assertExpectedChain' | 'getBalanceSnapshot' | 'getTokenAccountsByMints'
  >
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly tokenMints?: readonly string[]
}

interface MutableTokenBalance {
  readonly mint: string
  readonly program: SolanaTokenProgram
  readonly decimals: number
  readonly accountAddresses: string[]
  readonly contextSlot: number
  amount: bigint
}

function mergeTokenAccount(
  balances: Map<string, MutableTokenBalance>,
  account: SolanaTokenAccountBalance,
  contextSlot: number
): void {
  const current = balances.get(account.mint)
  if (current) {
    if (current.program !== account.program || current.decimals !== account.decimals) {
      throw new Error('Solana token mint returned inconsistent identity metadata')
    }
    current.amount += BigInt(account.amountRaw)
    if (current.amount.toString().length > MAXIMUM_RAW_AMOUNT_DIGITS) {
      throw new Error('Solana token balance exceeds the supported range')
    }
    current.accountAddresses.push(account.accountAddress)
    return
  }
  if (balances.size >= MAXIMUM_TOKEN_ASSETS) {
    throw new Error('Solana token inventory exceeds the supported limit')
  }
  balances.set(account.mint, {
    mint: account.mint,
    program: account.program,
    decimals: account.decimals,
    accountAddresses: [account.accountAddress],
    contextSlot,
    amount: BigInt(account.amountRaw)
  })
}

export async function readSolanaBalances(
  input: ReadSolanaBalancesInput
): Promise<SolanaBalanceReadModel> {
  const parsedChainId = parseChainId(input.chainId)
  if (
    parsedChainId.namespace !== 'solana' ||
    !getSolanaNetworkConfigs().some(network => network.chainId === parsedChainId.id)
  ) {
    throw new Error('Unsupported Solana chain ID')
  }
  const chainId = parsedChainId.id
  const address = parseSolanaPublicKey(input.address)
  await input.rpc.assertExpectedChain(input.signal)
  const tokenMints = input.tokenMints ?? []
  const [native, tokenAccounts] =
    tokenMints.length === 0
      ? [
          await input.rpc.getBalanceSnapshot(address, input.signal),
          Object.freeze({ contextSlot: 0, accounts: Object.freeze([]) })
        ]
      : await Promise.all([
          input.rpc.getBalanceSnapshot(address, input.signal),
          input.rpc.getTokenAccountsByMints(address, tokenMints, input.signal)
        ])
  const updatedAt = (input.now ?? Date.now)()
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error('Invalid Solana balance timestamp')
  }
  const balances = new Map<string, MutableTokenBalance>()
  for (const account of tokenAccounts.accounts) {
    mergeTokenAccount(balances, account, tokenAccounts.contextSlot)
  }
  const tokens = [...balances.values()]
    .map(balance =>
      Object.freeze({
        assetId: `${chainId}/token:${balance.mint}`,
        mint: balance.mint,
        program: balance.program,
        amountRaw: balance.amount.toString(),
        decimals: balance.decimals,
        accountAddresses: Object.freeze([...balance.accountAddresses].sort()),
        contextSlot: balance.contextSlot
      })
    )
    .sort((left, right) => left.assetId.localeCompare(right.assetId))
  return Object.freeze({
    chainId,
    address,
    native: Object.freeze({
      assetId: `${chainId}/slip44:501`,
      amountRaw: native.amountRaw,
      contextSlot: native.contextSlot
    }),
    tokens: Object.freeze(tokens),
    updatedAt
  })
}
