import type { AssetId, ChainId } from '@/core/chains/domain'
import { parseChainId } from './caip2'

const ASSET_NAMESPACE_PATTERN = /^[-a-z0-9]{3,8}$/
const ASSET_REFERENCE_PATTERN = /^[-.%a-zA-Z0-9]{1,128}$/

export interface ParsedAssetId {
  readonly id: AssetId
  readonly chainId: ChainId
  readonly namespace: string
  readonly reference: string
}

function hasCanonicalPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue
    if (!/^[0-9A-F]{2}$/.test(value.slice(index + 1, index + 3))) {
      return false
    }
    index += 2
  }
  return true
}

export function assertAssetNamespace(value: string): void {
  if (!ASSET_NAMESPACE_PATTERN.test(value)) {
    throw new Error(`Invalid CAIP-19 asset namespace: ${value}`)
  }
}

export function assertAssetReference(value: string): void {
  if (!ASSET_REFERENCE_PATTERN.test(value) || !hasCanonicalPercentEncoding(value)) {
    throw new Error(`Invalid CAIP-19 asset reference: ${value}`)
  }
}

export function createAssetId(chainId: ChainId, namespace: string, reference: string): AssetId {
  assertAssetNamespace(namespace)
  assertAssetReference(reference)
  return `${chainId}/${namespace}:${reference}` as AssetId
}

export function parseAssetId(value: string): ParsedAssetId {
  if (typeof value !== 'string') {
    throw new Error('Invalid CAIP-19 asset ID')
  }
  const slashIndex = value.indexOf('/')
  const separatorIndex = value.indexOf(':', slashIndex + 1)
  if (
    slashIndex <= 0 ||
    separatorIndex <= slashIndex + 1 ||
    value.indexOf('/', slashIndex + 1) !== -1 ||
    value.indexOf(':', separatorIndex + 1) !== -1
  ) {
    throw new Error(`Invalid CAIP-19 asset ID: ${value}`)
  }

  const chain = parseChainId(value.slice(0, slashIndex))
  const namespace = value.slice(slashIndex + 1, separatorIndex)
  const reference = value.slice(separatorIndex + 1)
  assertAssetNamespace(namespace)
  assertAssetReference(reference)

  return Object.freeze({
    id: createAssetId(chain.id, namespace, reference),
    chainId: chain.id,
    namespace,
    reference
  })
}
