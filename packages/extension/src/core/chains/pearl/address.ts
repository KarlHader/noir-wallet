import { PEARL_CHAIN_IDS } from '@/core/chains/registry/chain-ids'

const PEARL_MAINNET = PEARL_CHAIN_IDS.mainnet
const PEARL_TESTNET = PEARL_CHAIN_IDS.testnet

export function parseSupportedPearlAddress(address: string, chainId: string): string {
  if (typeof address !== 'string' || address.trim() !== address || address.length === 0) {
    throw new Error('Pearl address is invalid')
  }
  const expectedPrefix =
    chainId === PEARL_MAINNET ? 'prl1p' : chainId === PEARL_TESTNET ? 'tprl1p' : null
  if (expectedPrefix === null || !address.startsWith(expectedPrefix)) {
    throw new Error('Pearl address does not match the selected network')
  }
  if (!/^[a-z0-9]{14,90}$/.test(address)) {
    throw new Error('Pearl address encoding is invalid')
  }
  return address
}
