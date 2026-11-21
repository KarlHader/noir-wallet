import { parseZcashAddress } from '@/core/address-book/address-book'
import { getZcashChainId } from '@/core/chains/registry'
import type { AccountNetworksView } from './account-networks-client'
import type { AccountAddresses, FundingSource, Network } from '@/types/wallet'

export function getConfidentialZcashTransferRecipients(
  account: AccountNetworksView | null | undefined,
  network: Network
): readonly Readonly<{ address: string; privacy: FundingSource }>[] {
  const chain = account?.networks.find(item => item.chain.id === getZcashChainId(network))
  if (!chain || chain.chain.family !== 'zcash') return []
  const recipients = new Map<FundingSource, { address: string; privacy: FundingSource }>()
  for (const candidate of chain.addresses) {
    try {
      const parsed = parseZcashAddress(candidate.value, network)
      const privacy = parsed.scheme.startsWith('zcash-transparent-')
        ? 'transparent'
        : candidate.value.startsWith(network === 'mainnet' ? 'u1' : 'utest1')
          ? 'shielded'
          : null
      if (privacy && !recipients.has(privacy))
        recipients.set(privacy, { address: parsed.address, privacy })
    } catch {
      // Only the current account's valid native receive addresses are eligible.
    }
  }
  return [...recipients.values()]
}

export function resolveZcashSelfTransfer(
  addresses: AccountAddresses | null | undefined,
  source: FundingSource,
  network: Network
): Readonly<{ source: FundingSource; fromAddress: string; toAddress: string }> | null {
  if (!addresses) return null
  const fromAddress = addresses[source]
  const toAddress = addresses[source === 'transparent' ? 'shielded' : 'transparent']
  if (!fromAddress || !toAddress || fromAddress === toAddress) return null
  try {
    const from = parseZcashAddress(fromAddress, network)
    const to = parseZcashAddress(toAddress, network)
    const fromTransparent = from.scheme.startsWith('zcash-transparent-')
    const toTransparent = to.scheme.startsWith('zcash-transparent-')
    if (fromTransparent !== (source === 'transparent') || toTransparent === fromTransparent) {
      return null
    }
    return Object.freeze({ source, fromAddress: from.address, toAddress: to.address })
  } catch {
    return null
  }
}
