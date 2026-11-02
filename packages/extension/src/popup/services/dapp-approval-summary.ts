import { parseChainId } from '@/core/chains/registry'
import { resolveEvmChainIconAlias } from '@/config/icons'
import { parseCustomServiceUrl } from '@/core/chains/chain-endpoint-settings'
import {
  parseSigningSummary,
  type BitcoinBip322MessageSummary,
  type BitcoinPsbtSummary,
  type EvmPersonalMessageSummary,
  type EvmTransactionSummary,
  type EvmTypedDataSummary,
  type NearNep413MessageSummary,
  type NearTransactionSummary,
  type SolanaMessageSummary,
  type SolanaTransactionSummary
} from '@/core/keyring/domain'

export interface EvmPrivateTransferApprovalSummary {
  readonly chainId: number
  readonly chainName: string
  readonly iconChain: string
  readonly sourceAddress: string
  readonly recipient: string
  readonly asset: Readonly<{ symbol: string; decimals: number }>
  readonly amountRaw: string
  readonly estimatedOutputRaw: string
  readonly minimumOutputRaw: string
  readonly router: string
  readonly expiresAt: number
  readonly approvalRequired: boolean
}

export interface EvmAddNetworkApprovalSummary {
  readonly chainId: `eip155:${number}`
  readonly numericChainId: number
  readonly chainName: string
  readonly iconChain: string
  readonly nativeCurrency: Readonly<{ name: string; symbol: string; decimals: number }>
  readonly rpcUrl: string
  readonly explorerUrl?: string
}

export function parseEvmAddNetworkApproval(value: unknown): EvmAddNetworkApprovalSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const currency = data.nativeCurrency
  if (!currency || typeof currency !== 'object' || Array.isArray(currency)) return null
  const nativeCurrency = currency as Record<string, unknown>
  if (
    data.action !== 'add' ||
    typeof data.chainId !== 'string' ||
    !/^eip155:[1-9][0-9]*$/.test(data.chainId) ||
    !Number.isSafeInteger(Number(data.chainId.slice(7))) ||
    typeof data.chainName !== 'string' ||
    data.chainName.length === 0 ||
    typeof nativeCurrency.name !== 'string' ||
    nativeCurrency.name.length === 0 ||
    typeof nativeCurrency.symbol !== 'string' ||
    nativeCurrency.symbol.length === 0 ||
    !Number.isSafeInteger(nativeCurrency.decimals) ||
    (nativeCurrency.decimals as number) < 0 ||
    (nativeCurrency.decimals as number) > 255
  )
    return null
  try {
    const rpcUrl = parseCustomServiceUrl(data.rpcUrl, 'custom RPC URL')
    const explorerUrl =
      data.explorerUrl === undefined
        ? undefined
        : parseCustomServiceUrl(data.explorerUrl, 'custom block explorer URL')
    return Object.freeze({
      chainId: data.chainId as `eip155:${number}`,
      numericChainId: Number(data.chainId.slice(7)),
      chainName: data.chainName,
      iconChain: resolveEvmChainIconAlias(data.chainId),
      nativeCurrency: Object.freeze({
        name: nativeCurrency.name,
        symbol: nativeCurrency.symbol,
        decimals: nativeCurrency.decimals as number
      }),
      rpcUrl,
      ...(explorerUrl === undefined ? {} : { explorerUrl })
    })
  } catch {
    return null
  }
}

export function parseEvmPrivateTransferApproval(
  value: unknown
): EvmPrivateTransferApprovalSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const expectedKeys = new Set([
    'chainId',
    'chainName',
    'iconChain',
    'sourceAddress',
    'recipient',
    'asset',
    'amountRaw',
    'estimatedOutputRaw',
    'minimumOutputRaw',
    'router',
    'expiresAt',
    'approvalRequired',
    'favicon',
    'faviconPageUrl'
  ])
  if (Object.keys(record).some(key => !expectedKeys.has(key))) return null
  const asset = record.asset
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return null
  const assetRecord = asset as Record<string, unknown>
  if (
    Object.keys(assetRecord).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(assetRecord, 'symbol') ||
    !Object.prototype.hasOwnProperty.call(assetRecord, 'decimals')
  ) {
    return null
  }
  const rawAmounts = [record.amountRaw, record.estimatedOutputRaw, record.minimumOutputRaw]
  if (
    !Number.isSafeInteger(record.chainId) ||
    (record.chainId as number) <= 0 ||
    typeof record.chainName !== 'string' ||
    typeof record.iconChain !== 'string' ||
    typeof record.sourceAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(record.sourceAddress) ||
    typeof record.recipient !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(record.recipient) ||
    typeof assetRecord.symbol !== 'string' ||
    assetRecord.symbol.length === 0 ||
    assetRecord.symbol.length > 64 ||
    !Number.isSafeInteger(assetRecord.decimals) ||
    (assetRecord.decimals as number) < 0 ||
    (assetRecord.decimals as number) > 255 ||
    rawAmounts.some(amount => typeof amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amount)) ||
    BigInt(record.minimumOutputRaw as string) > BigInt(record.estimatedOutputRaw as string) ||
    typeof record.router !== 'string' ||
    !record.router.toLowerCase().includes('nearintents') ||
    !Number.isSafeInteger(record.expiresAt) ||
    (record.expiresAt as number) <= 0 ||
    typeof record.approvalRequired !== 'boolean'
  ) {
    return null
  }
  return Object.freeze({
    chainId: record.chainId as number,
    chainName: record.chainName,
    iconChain: record.iconChain,
    sourceAddress: record.sourceAddress.toLowerCase(),
    recipient: record.recipient.toLowerCase(),
    asset: Object.freeze({
      symbol: assetRecord.symbol,
      decimals: assetRecord.decimals as number
    }),
    amountRaw: record.amountRaw as string,
    estimatedOutputRaw: record.estimatedOutputRaw as string,
    minimumOutputRaw: record.minimumOutputRaw as string,
    router: record.router,
    expiresAt: record.expiresAt as number,
    approvalRequired: record.approvalRequired
  })
}

export function formatDAppHost(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

export function resolveDAppFaviconPageUrl(data: unknown, origin: string): string {
  const candidate =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? Reflect.get(data, 'faviconPageUrl')
      : undefined
  if (typeof candidate !== 'string') return origin
  try {
    const expectedOrigin = new URL(origin).origin
    const parsed = new URL(candidate)
    if (parsed.origin !== expectedOrigin) return origin
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return origin
  }
}

export function parseBitcoinSigningSummary(
  value: unknown,
  operation: 'transaction' | 'message'
): BitcoinPsbtSummary | BitcoinBip322MessageSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const chainId = Reflect.get(value, 'chainId')
  if (typeof chainId !== 'string') return null

  try {
    const parsedChainId = parseChainId(chainId)
    if (parsedChainId.namespace !== 'bip122') return null
    const summary = parseSigningSummary(value, {
      family: 'bitcoin',
      chainId: parsedChainId.id,
      operation
    })
    if (operation === 'transaction' && summary.schema === 'bitcoin.psbt.v1') return summary
    if (operation === 'message' && summary.schema === 'bitcoin.bip322-message.v1') return summary
    return null
  } catch {
    return null
  }
}

export function parseEvmMessageSummary(
  value: unknown
): EvmPersonalMessageSummary | EvmTypedDataSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const chainId = Reflect.get(value, 'chainId')
  if (typeof chainId !== 'string') return null

  try {
    const parsedChainId = parseChainId(chainId)
    if (parsedChainId.namespace !== 'eip155') return null
    const summary = parseSigningSummary(value, {
      family: 'evm',
      chainId: parsedChainId.id,
      operation: 'message'
    })
    return summary.schema === 'evm.personal-message.v1' || summary.schema === 'evm.typed-data.v1'
      ? summary
      : null
  } catch {
    return null
  }
}

export function parseEvmTransactionSummary(value: unknown): EvmTransactionSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const chainId = Reflect.get(value, 'chainId')
  if (typeof chainId !== 'string') return null

  try {
    const parsedChainId = parseChainId(chainId)
    if (parsedChainId.namespace !== 'eip155') return null
    const summary = parseSigningSummary(value, {
      family: 'evm',
      chainId: parsedChainId.id,
      operation: 'transaction'
    })
    return summary.schema === 'evm.transaction.v1' ? summary : null
  } catch {
    return null
  }
}

export function parseNativeSigningSummary(
  value: unknown,
  family: 'solana' | 'near',
  operation: 'transaction' | 'message'
):
  | SolanaTransactionSummary
  | SolanaMessageSummary
  | NearTransactionSummary
  | NearNep413MessageSummary
  | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const chainId = Reflect.get(value, 'chainId')
  if (typeof chainId !== 'string') return null
  try {
    const parsedChainId = parseChainId(chainId)
    if (parsedChainId.namespace !== family) return null
    const summary = parseSigningSummary(value, {
      family,
      chainId: parsedChainId.id,
      operation
    })
    if (
      family === 'solana' &&
      (summary.schema === 'solana.transaction.v1' || summary.schema === 'solana.message.v1')
    ) {
      return summary
    }
    if (
      family === 'near' &&
      (summary.schema === 'near.transaction.v1' || summary.schema === 'near.nep413-message.v1')
    ) {
      return summary
    }
    return null
  } catch {
    return null
  }
}
