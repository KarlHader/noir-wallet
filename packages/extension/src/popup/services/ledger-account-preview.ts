import { formatBaseUnitDecimalAmount, formatDecimalAmount } from '@/lib/number-format'
import type { LedgerPublicAccount } from '@/core/wallet/hardware-wallet-data'
import {
  setActiveChainEndpointSettings,
  findChainEndpointOverride
} from '@/core/chains/chain-endpoint-settings'
import { resolveActiveEvmNetworkConfig } from '@/core/chains/evm-runtime-config'
import {
  resolveSolanaRuntimeNetworkConfig,
  resolveNearRuntimeNetworkConfig
} from '@/core/chains/solana-near-runtime-config'
import { getBitcoinChainId } from '@/core/chains/registry'
import { createConfiguredEvmRpcClient } from '@/infrastructure/chains/evm'
import { createConfiguredSolanaRpcClient } from '@/infrastructure/chains/solana'
import { createConfiguredNearRpcClient } from '@/infrastructure/chains/near'
import { discoverNearAccounts } from '@/infrastructure/chains/near/near-account-discovery'
import { createConfiguredBitcoinEsploraClient } from '@/infrastructure/chains/bitcoin'
import type { Network } from '@/types'
import { chainEndpointSettingsClient } from './chain-endpoint-settings-client'

export type LedgerAccountPreview =
  | {
      readonly status: 'available'
      readonly balanceRaw?: string
      readonly decimals?: number
      readonly symbol?: string
      readonly networkName: string
      readonly used: boolean
      readonly accountName?: string
    }
  | { readonly status: 'unavailable' }

export function ledgerAccountPreviewLabel(preview?: LedgerAccountPreview): string {
  if (!preview) return 'Loading'
  if (preview.status === 'unavailable') return 'Unavailable'
  if (preview.balanceRaw !== undefined && preview.decimals !== undefined) {
    const amount = formatBaseUnitDecimalAmount(BigInt(preview.balanceRaw), preview.decimals)
    const display = formatDecimalAmount(amount, { maximumFractionDigits: 6 })
    return `${display} ${preview.symbol ?? ''}`.trim()
  }
  return preview.used ? 'Activity found' : '—'
}

export function ledgerAccountPreviewNetworkName(
  previews: Readonly<Record<string, LedgerAccountPreview>>
): string | undefined {
  return Object.values(previews).find(preview => preview.status === 'available')?.networkName
}

export async function readLedgerAccountPreview(
  account: LedgerPublicAccount,
  network: Network,
  signal: AbortSignal
): Promise<LedgerAccountPreview> {
  try {
    const settings = setActiveChainEndpointSettings(await chainEndpointSettingsClient.read())
    signal.throwIfAborted()
    if (account.family === 'evm') {
      const config = resolveActiveEvmNetworkConfig(network, settings)
      const rpc = createConfiguredEvmRpcClient(network, config)
      await rpc.assertExpectedChain(signal)
      const [balanceRaw, nonce] = await Promise.all([
        rpc.getNativeBalance(account.address, signal),
        rpc.getTransactionCount(account.address, 'latest', signal)
      ])
      return {
        status: 'available',
        balanceRaw,
        decimals: config.nativeCurrency.decimals,
        symbol: config.nativeCurrency.symbol,
        networkName: config.displayName,
        used: BigInt(nonce) > 0n || BigInt(balanceRaw) > 0n
      }
    }
    if (account.family === 'solana') {
      const config = resolveSolanaRuntimeNetworkConfig(network, settings)
      const rpc = createConfiguredSolanaRpcClient(config)
      await rpc.assertExpectedChain(signal)
      const [balanceRaw, signatures] = await Promise.all([
        rpc.getBalance(account.address, signal),
        rpc.getSignaturesForAddress(account.address, 1, undefined, signal)
      ])
      return {
        status: 'available',
        balanceRaw,
        decimals: 9,
        symbol: 'SOL',
        networkName: config.displayName,
        used: signatures.length > 0 || BigInt(balanceRaw) > 0n
      }
    }
    if (account.family === 'near') {
      const config = resolveNearRuntimeNetworkConfig(network, settings)
      const rpc = createConfiguredNearRpcClient(config)
      await rpc.assertExpectedChain(signal)
      const discovered = await discoverNearAccounts({
        network,
        publicKey: account.publicKey,
        rpc,
        signal
      })
      const snapshot = await rpc.getAccount(discovered.primaryAccountId, signal)
      return {
        status: 'available',
        balanceRaw: snapshot?.amountRaw ?? '0',
        decimals: 24,
        symbol: 'NEAR',
        networkName: config.displayName,
        used: snapshot !== null,
        accountName:
          discovered.primaryAccountId !== account.address ? discovered.primaryAccountId : undefined
      }
    }
    if (account.family === 'bitcoin') {
      const override = findChainEndpointOverride(settings, getBitcoinChainId(network))?.rpc
      const rpc = createConfiguredBitcoinEsploraClient(network, override?.url)
      await rpc.assertExpectedChain(signal)
      const activity = await rpc.getAddressActivity(account.address, signal)
      // A first-address probe is not the balance of the whole xpub account.
      return {
        status: 'available',
        networkName: network === 'mainnet' ? 'Bitcoin' : 'Bitcoin Testnet',
        used: activity.used
      }
    }
    return { status: 'unavailable' }
  } catch (error) {
    signal.throwIfAborted()
    return { status: 'unavailable' }
  }
}
