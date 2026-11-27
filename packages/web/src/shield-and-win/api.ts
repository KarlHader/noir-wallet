import { isTransparentZcashAddress } from './claim'

const PRODUCTION_BASE = 'https://apinoir.refburrow.top/v1/shield-win'
const DEVELOPMENT_BASE = '/api/shield-win'

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/
const ZCASH_TX_HASH = /^(?:0x)?[0-9a-fA-F]{64}$/
const CAMPAIGN_STATUSES = ['UPCOMING', 'ACTIVE', 'SOLD_OUT', 'ENDED'] as const
const DRAW_RESULTS = ['WON', 'NOT_WON'] as const
const REWARD_STATUSES = ['UNCLAIMED', 'CLAIMING', 'SENDING', 'COMPLETED', 'FAILED'] as const

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]
export type DrawResult = (typeof DRAW_RESULTS)[number]
export type RewardStatus = (typeof REWARD_STATUSES)[number]

export interface ShieldWinCampaignAsset {
  readonly asset_id: string
  readonly decimal: number
}

export interface ShieldWinCampaign {
  readonly id: number
  readonly name: string
  readonly status: CampaignStatus
  readonly start_time: number
  readonly end_time: number
  readonly min_usd_value: string
  readonly max_winners: number
  readonly winner_count: number
  readonly draw_count: number
  readonly reward_amount: string
  readonly reward_asset: string
  readonly assets: readonly ShieldWinCampaignAsset[]
}

export interface ShieldWinEntry {
  readonly id: number
  readonly operation_id: number
  readonly campaign_id: number
  readonly destination_asset: string
  readonly usd_value: string
  readonly draw_result: DrawResult
  readonly reward_amount?: string
  readonly reward_asset?: string
  readonly reward_status?: RewardStatus
  readonly transfer_hash?: string
  readonly shield_completed_at: number
}

export interface ShieldWinEntryPage {
  readonly list: readonly ShieldWinEntry[]
  readonly total: number
  readonly page_size: number
  readonly page_number: number
  readonly has_next_page: boolean
}

export interface GetEntriesQuery {
  readonly wallet_address?: string
  readonly campaign_id?: number
  readonly draw_result?: DrawResult
  readonly page_size?: number
  readonly page_number?: number
}

export interface ClaimRewardInput {
  readonly entry_id: number
  readonly wallet_address: string
  readonly zcash_address: string
  readonly signature: string
}

export interface ClaimRewardResult {
  readonly entry_id: number
  readonly reward_status: RewardStatus
}

export class ShieldWinApiError extends Error {
  readonly code: number
  readonly detail: string | null

  constructor(code: number, detail?: string | null) {
    super(messageForCode(code))
    this.name = 'ShieldWinApiError'
    this.code = code
    this.detail = safeDetail(detail ?? null)
  }
}

export function shieldWinApiBase(): string {
  return import.meta.env?.DEV ? DEVELOPMENT_BASE : PRODUCTION_BASE
}

export function selectCampaign(list: readonly ShieldWinCampaign[]): ShieldWinCampaign | null {
  return list.find(campaign => campaign.status === 'ACTIVE') ?? list[0] ?? null
}

export function campaignFromUnknown(value: unknown): ShieldWinCampaign | null {
  try {
    return parseCampaign(value)
  } catch {
    return null
  }
}

export async function getCampaigns(
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<readonly ShieldWinCampaign[]> {
  const data = await call(endpoint('/campaigns'), { method: 'GET', signal }, fetcher)
  return parseCampaigns(data)
}

// operation_id is internal to the service. An empty list is a real result.
export async function getEntries(
  query: GetEntriesQuery,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<ShieldWinEntryPage> {
  const data = await call(entriesUrl(query), { method: 'GET', signal }, fetcher)
  return parseEntryPage(data)
}

export async function getAllEntries(
  query: Omit<GetEntriesQuery, 'page_size' | 'page_number'>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<readonly ShieldWinEntry[]> {
  const entries: ShieldWinEntry[] = []
  let pageNumber = 1
  while (true) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    const page = await getEntries(
      { ...query, page_size: 100, page_number: pageNumber },
      signal,
      fetcher
    )
    entries.push(...page.list)
    if (!page.has_next_page) return entries
    if (page.page_number !== pageNumber || page.list.length === 0 || entries.length >= page.total) {
      throw new Error('Shield & Win returned an invalid response.')
    }
    pageNumber += 1
  }
}

export async function claimReward(
  input: ClaimRewardInput,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<ClaimRewardResult> {
  assertClaimInput(input)
  const data = await call(
    endpoint('/claim'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entry_id: input.entry_id,
        wallet_address: input.wallet_address,
        zcash_address: input.zcash_address,
        signature: input.signature
      }),
      signal
    },
    fetcher
  )
  return parseClaimResult(data)
}

function endpoint(path: string): string {
  return `${shieldWinApiBase()}${path}`
}

function entriesUrl(query: GetEntriesQuery): string {
  const params = new URLSearchParams()
  if (query.wallet_address !== undefined) {
    if (query.wallet_address.length === 0) throw new Error('The wallet address is not valid.')
    params.set('wallet_address', query.wallet_address)
  }
  if (query.campaign_id !== undefined) {
    if (!isSafeInt(query.campaign_id, 0)) throw new Error('The campaign id is not valid.')
    params.set('campaign_id', String(query.campaign_id))
  }
  if (query.draw_result !== undefined) {
    if (!isDrawResult(query.draw_result)) throw new Error('The draw result is not valid.')
    params.set('draw_result', query.draw_result)
  }
  if (query.page_size !== undefined) {
    if (!isSafeInt(query.page_size, 1) || query.page_size > 100) {
      throw new Error('The page size is not valid.')
    }
    params.set('page_size', String(query.page_size))
  }
  if (query.page_number !== undefined) {
    if (!isSafeInt(query.page_number, 1)) throw new Error('The page number is not valid.')
    params.set('page_number', String(query.page_number))
  }
  const search = params.toString()
  return `${endpoint('/entries')}${search ? `?${search}` : ''}`
}

function assertClaimInput(input: ClaimRewardInput): void {
  if (!isSafeInt(input.entry_id, 0)) throw new Error('The entry id is not valid.')
  if (!EVM_ADDRESS.test(input.wallet_address)) throw new Error('The wallet address is not valid.')
  if (
    input.zcash_address !== input.zcash_address.trim() ||
    !isTransparentZcashAddress(input.zcash_address)
  ) {
    throw new Error('Enter a Zcash transparent address.')
  }
  if (!SIGNATURE.test(input.signature)) throw new Error('The signature is not valid.')
}

async function call(url: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...headersOf(init.headers)
      },
      cache: 'no-store'
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new Error('Shield & Win could not be reached.')
  }
  return readData(response)
}

async function readData(response: Response): Promise<unknown> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('Shield & Win returned an unreadable response.')
  }
  // Business failures are often returned with HTTP 200.
  if (!isRecord(body) || !isInteger(body.code)) invalidResponse()
  if (body.code !== 0) {
    const detail = typeof body.message === 'string' ? body.message : null
    throw new ShieldWinApiError(body.code, detail)
  }
  if (!('data' in body)) invalidResponse()
  return body.data
}

function parseCampaigns(data: unknown): ShieldWinCampaign[] {
  if (!Array.isArray(data)) invalidResponse()
  return data.map(parseCampaign)
}

function parseCampaign(value: unknown): ShieldWinCampaign {
  if (!isRecord(value) || !isCampaignStatus(value.status)) invalidResponse()
  return {
    id: integerField(value.id, 0),
    name: textField(value.name, 256),
    status: value.status,
    start_time: integerField(value.start_time, 0),
    end_time: integerField(value.end_time, 0),
    min_usd_value: decimalField(value.min_usd_value),
    max_winners: integerField(value.max_winners, 0),
    winner_count: integerField(value.winner_count, 0),
    draw_count: integerField(value.draw_count, 0),
    reward_amount: decimalField(value.reward_amount),
    reward_asset: textField(value.reward_asset, 64),
    assets: parseAssets(value.assets)
  }
}

function parseAssets(value: unknown): ShieldWinCampaignAsset[] {
  // Campaigns can omit this list. A present but malformed list is still invalid.
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) invalidResponse()
  return value.map(item => {
    if (!isRecord(item)) invalidResponse()
    return {
      asset_id: textField(item.asset_id, 256),
      decimal: integerField(item.decimal, 0)
    }
  })
}

function parseEntryPage(data: unknown): ShieldWinEntryPage {
  if (!isRecord(data) || !Array.isArray(data.list) || typeof data.has_next_page !== 'boolean') {
    invalidResponse()
  }
  return {
    list: data.list.map(parseEntry),
    total: integerField(data.total, 0),
    page_size: integerField(data.page_size, 0),
    page_number: integerField(data.page_number, 1),
    has_next_page: data.has_next_page
  }
}

function parseEntry(value: unknown): ShieldWinEntry {
  if (!isRecord(value) || !isDrawResult(value.draw_result)) invalidResponse()
  const entry: {
    id: number
    operation_id: number
    campaign_id: number
    destination_asset: string
    usd_value: string
    draw_result: DrawResult
    shield_completed_at: number
    reward_amount?: string
    reward_asset?: string
    reward_status?: RewardStatus
    transfer_hash?: string
  } = {
    id: integerField(value.id, 0),
    operation_id: integerField(value.operation_id, 0),
    campaign_id: integerField(value.campaign_id, 0),
    destination_asset: textField(value.destination_asset, 256),
    usd_value: decimalField(value.usd_value),
    draw_result: value.draw_result,
    shield_completed_at: integerField(value.shield_completed_at, 0)
  }
  const won = value.draw_result === 'WON'
  if (won || hasRewardField(value)) {
    entry.reward_amount = decimalField(value.reward_amount)
    entry.reward_asset = textField(value.reward_asset, 64)
    if (!isRewardStatus(value.reward_status)) invalidResponse()
    entry.reward_status = value.reward_status
  }
  if (typeof value.transfer_hash === 'string' && ZCASH_TX_HASH.test(value.transfer_hash)) {
    entry.transfer_hash = value.transfer_hash.replace(/^0x/, '')
  }
  return entry
}

function parseClaimResult(data: unknown): ClaimRewardResult {
  if (!isRecord(data) || !isRewardStatus(data.reward_status)) invalidResponse()
  return {
    entry_id: integerField(data.entry_id, 0),
    reward_status: data.reward_status
  }
}

function hasRewardField(value: Record<string, unknown>): boolean {
  return (
    value.reward_amount !== undefined ||
    value.reward_asset !== undefined ||
    value.reward_status !== undefined
  )
}

function messageForCode(code: number): string {
  switch (code) {
    case -400:
      return 'The request is not valid.'
    case -401:
      return 'The wallet is not authorized for this entry.'
    case -500:
      return 'Shield & Win is temporarily unavailable.'
    case 2004:
      return 'This reward has already been claimed.'
    case 4004:
      return 'This record does not exist.'
    default:
      return 'Shield & Win could not complete this request.'
  }
}

function safeDetail(detail: string | null): string | null {
  if (detail === null) return null
  const trimmed = detail.trim()
  if (trimmed.length === 0 || trimmed.length > 300) return null
  if (/0x[0-9a-fA-F]{64,}/.test(trimmed)) return null
  return trimmed
}

function headersOf(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
      record[key] = value
    })
    return record
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

function invalidResponse(): never {
  throw new Error('Shield & Win returned an invalid response.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isSafeInt(value: unknown, min: number): value is number {
  return isInteger(value) && Number.isSafeInteger(value) && value >= min
}

function integerField(value: unknown, min: number): number {
  if (!isSafeInt(value, min)) invalidResponse()
  return value
}

function textField(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) invalidResponse()
  return value
}

function decimalField(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !DECIMAL.test(value)) invalidResponse()
  return value
}

function isCampaignStatus(value: unknown): value is CampaignStatus {
  return typeof value === 'string' && CAMPAIGN_STATUSES.some(status => status === value)
}

function isDrawResult(value: unknown): value is DrawResult {
  return value === 'WON' || value === 'NOT_WON'
}

function isRewardStatus(value: unknown): value is RewardStatus {
  return typeof value === 'string' && REWARD_STATUSES.some(status => status === value)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
