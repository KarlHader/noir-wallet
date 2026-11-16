// Source: https://github.com/defuse-protocol/gitbook-docs/blob/main/treasury-addresses.md
const EVM_TREASURY = '0x2cff890f0378a11913b6129b2e97417a2c302680'
const EVM_TREASURY_CHAINS = new Set([
  'eip155:1',
  'eip155:10',
  'eip155:56',
  'eip155:100',
  'eip155:137',
  'eip155:143',
  'eip155:196',
  'eip155:42161',
  'eip155:43114',
  'eip155:8453',
  'eip155:9745',
  'eip155:80094'
])
const TREASURY_BY_CHAIN: Readonly<Record<string, string>> = Object.freeze({
  'bip122:000000000019d6689c085ae165831e93': '1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra',
  'bip122:00040fe8ec8471911baa1db1266ea15d': 't1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16',
  'near:mainnet': 'intents.near'
})

export function getActivityAddressAlias(
  chainId: string | undefined,
  address: string
): string | null {
  if (!chainId) return null
  if (EVM_TREASURY_CHAINS.has(chainId))
    return address.toLowerCase() === EVM_TREASURY ? 'NEAR Intents' : null
  return TREASURY_BY_CHAIN[chainId] === address ? 'NEAR Intents' : null
}
