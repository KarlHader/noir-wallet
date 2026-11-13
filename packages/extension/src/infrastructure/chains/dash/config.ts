import { getDashNetworkConfig } from '@/config/networks'
import { DASH_CHAIN_IDS, isDashChainId } from '@/core/chains/registry/chain-ids'
import type { Network } from '@/types'

/** 1 DASH = 100_000_000 duffs. */
export const DASH_DUFFS_PER_DASH = 100_000_000n

/**
 * Dash Core default `-minrelaytxfee` is 0.00001 DASH/kB.
 * 0.00001 DASH/kB = 1000 duffs/kB.
 */
export const DASH_MIN_RELAY_FEE_DUFFS_PER_KB = 1000n

/**
 * Wallet ceiling for an advertised relay fee. A hostile endpoint cannot raise
 * the single network fee above 0.1 DASH per 1000 legacy bytes.
 */
export const DASH_MAX_RELAY_FEE_DUFFS_PER_KB = 10_000_000n

/** Consensus `MAX_MONEY` (21_000_000 DASH), expressed in duffs. */
export const DASH_MAX_MONEY_DUFFS = 21_000_000n * DASH_DUFFS_PER_DASH

/**
 * dashcore-node `Dash.DEFAULT_MAX_ADDRESSES_QUERY`.
 * Address-history queries reject a larger batch. `/addrs/{addresses}/utxo`
 * uses the same service, so the client applies this cap before the request.
 */
export const DASH_INSIGHT_MAX_ADDRESSES = 10_000

/** insight-api `TxController.list` page length for `/txs`. */
export const DASH_INSIGHT_TX_PAGE_LENGTH = 10

/** BIP44 gap limit for the external receive chain and the internal change chain. */
export const DASH_GAP_LIMIT = 20

/**
 * Addresses checked past a completed gap in one batch.
 * A change output allocated outside the previous window is still discovered
 * on the next refresh, without a local reservation.
 */
export const DASH_LOOKAHEAD_ADDRESSES = DASH_GAP_LIMIT * 2

/** Coinbase outputs are spendable after this many confirmations. */
export const DASH_COINBASE_MATURITY = 100

/** Hard stop for one receive or change chain so a hostile indexer cannot run forever. */
export const DASH_MAX_ADDRESSES_PER_CHAIN = 1_000

/** Relay fee is charged per 1000 legacy serialized bytes, not per virtual byte. */
export const DASH_LEGACY_FEE_BYTES_PER_KB = 1000n

/**
 * Dash Core P2PKH dust-relay size is 182 bytes (34-byte CTxOut + 148-byte CTxIn).
 * dustDuffs = max(1, floor(182 * duffsPerKb / 1000)).
 */
export const DASH_P2PKH_DUST_RELAY_BYTES = 182n

/** Standard Dash transaction size limit used when estimating the single network fee. */
export const DASH_MAX_LEGACY_TX_BYTES = 100_000

const MAX_DECIMAL_INPUT_LENGTH = 64

export interface DashInsightNetworkIdentity {
  readonly chainId: (typeof DASH_CHAIN_IDS)[Network]
  readonly network: Network
  readonly genesisHash: string
  readonly insightNetwork: 'livenet' | 'testnet'
  readonly testnet: boolean
  readonly p2pkhVersion: number
  readonly p2shVersion: number
}

export function resolveDashInsightNetwork(chainId: string): DashInsightNetworkIdentity {
  if (!isDashChainId(chainId)) throw new Error('Invalid Dash chain ID')
  const network = chainId === DASH_CHAIN_IDS.mainnet ? 'mainnet' : 'testnet'
  const config = getDashNetworkConfig(network)
  return Object.freeze({
    chainId: config.chainId,
    network,
    genesisHash: config.genesisHash,
    insightNetwork: network === 'mainnet' ? 'livenet' : 'testnet',
    testnet: network === 'testnet',
    p2pkhVersion: config.p2pkhVersion,
    p2shVersion: config.p2shVersion
  })
}

function invalidDecimal(): Error {
  return new Error('Invalid Dash decimal amount')
}

/**
 * Converts an unsigned base-10 DASH string into duffs.
 * At most 8 fractional digits. Leading zeros are significant only as zero.
 * The fractional digits are scaled in integer arithmetic so a value such as
 * 1.99999999 becomes 199999999 duffs without a binary float.
 */
export function parseDashDecimalToDuffs(value: string): bigint {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DECIMAL_INPUT_LENGTH) {
    throw invalidDecimal()
  }
  if (!/^[0-9]+(?:\.[0-9]{1,8})?$/.test(value)) throw invalidDecimal()
  const separator = value.indexOf('.')
  const whole = separator === -1 ? value : value.slice(0, separator)
  const fraction = separator === -1 ? '' : value.slice(separator + 1)
  const duffs = BigInt(whole) * DASH_DUFFS_PER_DASH + BigInt(fraction.padEnd(8, '0') || '0')
  if (duffs > DASH_MAX_MONEY_DUFFS) throw invalidDecimal()
  return duffs
}

/** Exact relay-fee conversion. Values below the network minimum use that minimum. */
export function resolveDashRelayFeeDuffsPerKb(dashPerKb: string): bigint {
  const parsed = parseDashDecimalToDuffs(dashPerKb)
  if (parsed > DASH_MAX_RELAY_FEE_DUFFS_PER_KB) {
    throw new Error('Dash relay fee exceeds the maximum')
  }
  return parsed < DASH_MIN_RELAY_FEE_DUFFS_PER_KB ? DASH_MIN_RELAY_FEE_DUFFS_PER_KB : parsed
}

/**
 * Single network fee for a legacy serialized transaction.
 * `fee = ceil(legacyBytes * duffsPerKb / 1000)`.
 */
export function estimateDashLegacyFeeDuffs(legacyBytes: number, duffsPerKb: bigint): bigint {
  if (
    !Number.isSafeInteger(legacyBytes) ||
    legacyBytes <= 0 ||
    legacyBytes > DASH_MAX_LEGACY_TX_BYTES
  ) {
    throw new Error('Invalid Dash transaction size')
  }
  if (
    typeof duffsPerKb !== 'bigint' ||
    duffsPerKb < DASH_MIN_RELAY_FEE_DUFFS_PER_KB ||
    duffsPerKb > DASH_MAX_RELAY_FEE_DUFFS_PER_KB
  ) {
    throw new Error('Invalid Dash fee rate')
  }
  return (
    (BigInt(legacyBytes) * duffsPerKb + (DASH_LEGACY_FEE_BYTES_PER_KB - 1n)) /
    DASH_LEGACY_FEE_BYTES_PER_KB
  )
}

/** Minimum relayable value of one standard P2PKH output at the supplied duffs/kB rate. */
export function dashP2pkhDustDuffs(duffsPerKb: bigint): bigint {
  if (
    typeof duffsPerKb !== 'bigint' ||
    duffsPerKb < DASH_MIN_RELAY_FEE_DUFFS_PER_KB ||
    duffsPerKb > DASH_MAX_RELAY_FEE_DUFFS_PER_KB
  ) {
    throw new Error('Invalid Dash fee rate')
  }
  const dust = (DASH_P2PKH_DUST_RELAY_BYTES * duffsPerKb) / DASH_LEGACY_FEE_BYTES_PER_KB
  return dust === 0n ? 1n : dust
}
