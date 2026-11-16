import {
  nearImplicitAccountIdFromPublicKey,
  parseNearAccountId,
  parseNearPublicKey
} from '@/core/chains/near'
import { fetchWithTimeout } from '@/lib/fetch-utils'
import type { Network } from '@/types'

import type { NearReadRpc } from './near-rpc-types'

const MAXIMUM_DISCOVERY_RESPONSE_BYTES = 64 * 1024
const MAXIMUM_DISCOVERED_ACCOUNT_COUNT = 32
const DISCOVERY_TIMEOUT_MS = 5_000

export interface NearAccountDiscoveryResult {
  readonly implicitAccountId: string
  readonly primaryAccountId: string
  readonly accountIds: readonly string[]
}

export interface DiscoverNearAccountsInput {
  readonly network: Network
  readonly publicKey: string
  readonly rpc: Pick<NearReadRpc, 'getAccount' | 'getAccessKey'>
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetchWithTimeout
}

function discoveryOrigin(network: Network): string {
  return network === 'mainnet' ? 'https://api.fastnear.com' : 'https://test.api.fastnear.com'
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_DISCOVERY_RESPONSE_BYTES) {
      throw new Error('NEAR account discovery response is too large')
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAXIMUM_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('NEAR account discovery response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parseDiscoveryResponse(value: unknown, expectedPublicKey: string): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid NEAR account discovery response')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== 2 ||
    record.public_key !== expectedPublicKey ||
    !Array.isArray(record.account_ids) ||
    record.account_ids.length > MAXIMUM_DISCOVERED_ACCOUNT_COUNT
  ) {
    throw new Error('Invalid NEAR account discovery response')
  }
  const accountIds = record.account_ids.map(value =>
    parseNearAccountId(value, 'Discovered NEAR account ID')
  )
  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error('Duplicate NEAR account discovery result')
  }
  return Object.freeze(accountIds)
}

export async function discoverNearAccounts(
  input: DiscoverNearAccountsInput
): Promise<NearAccountDiscoveryResult> {
  const publicKey = parseNearPublicKey(input.publicKey)
  const implicitAccountId = nearImplicitAccountIdFromPublicKey(publicKey)
  const fetchImpl = input.fetchImpl ?? fetchWithTimeout
  const response = await fetchImpl(
    `${discoveryOrigin(input.network)}/v0/public_key/${encodeURIComponent(publicKey)}`,
    {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }
  )
  if (!response.ok) {
    throw new Error(`NEAR account discovery failed with HTTP ${response.status}`)
  }
  const discovered = parseDiscoveryResponse(JSON.parse(await readBoundedText(response)), publicKey)
  const namedCandidates = discovered.filter(accountId => accountId !== implicitAccountId)
  const verified = (
    await Promise.all(
      namedCandidates.map(async accountId => {
        const [account, accessKey] = await Promise.all([
          input.rpc.getAccount(accountId, input.signal),
          input.rpc.getAccessKey(accountId, publicKey, input.signal)
        ])
        if (
          !account ||
          !accessKey ||
          account.accountId !== accountId ||
          accessKey.accountId !== accountId ||
          accessKey.publicKey !== publicKey ||
          accessKey.permission.kind !== 'full-access'
        ) {
          return null
        }
        return Object.freeze({
          accountId,
          balance: BigInt(account.amountRaw) + BigInt(account.lockedRaw)
        })
      })
    )
  ).filter(value => value !== null)
  verified.sort(
    (left, right) =>
      (left.balance === right.balance ? 0 : left.balance > right.balance ? -1 : 1) ||
      left.accountId.localeCompare(right.accountId)
  )
  const namedAccountIds = verified.map(value => value.accountId)
  return Object.freeze({
    implicitAccountId,
    primaryAccountId: namedAccountIds[0] ?? implicitAccountId,
    accountIds: Object.freeze([...namedAccountIds, implicitAccountId])
  })
}
