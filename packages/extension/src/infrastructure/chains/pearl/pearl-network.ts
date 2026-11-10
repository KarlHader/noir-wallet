import type { Network } from 'bitcoinjs-lib'
import { PEARL_MAINNET_CHAIN_ID, type PearlCoinSelection } from './pearl-transaction-model'

/** bitcoinjs-lib network params for Pearl BIP-86 Taproot (custom bech32 HRP). */
export const PEARL_BITCOINJS_MAINNET = Object.freeze({
  messagePrefix: '\x18Pearl Signed Message:\n',
  bech32: 'prl',
  bip32: Object.freeze({ public: 0x0488b21e, private: 0x0488ade4 }),
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80
}) satisfies Network

export const PEARL_BITCOINJS_TESTNET = Object.freeze({
  messagePrefix: '\x18Pearl Signed Message:\n',
  bech32: 'tprl',
  bip32: Object.freeze({ public: 0x043587cf, private: 0x04358394 }),
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef
}) satisfies Network

export function pearlBitcoinJsNetwork(chainId: PearlCoinSelection['chainId']): Network {
  return chainId === PEARL_MAINNET_CHAIN_ID ? PEARL_BITCOINJS_MAINNET : PEARL_BITCOINJS_TESTNET
}
