/**
 * Wire format expected by the collector API
 * (POST https://datareport.rhea.finance/v1/events/common).
 * The JSON array of these payloads is AES-128-CBC encrypted before upload.
 */
export interface AnalyticsEventPayload {
  chain: import('./constants.ts').AnalyticsChain
  event_name: string
  extra: string
  has_transaction: 0 | 1
  input_amount: string
  input_symbol: string
  input_token_code: string
  output_amount: string
  output_symbol: string
  output_token_code: string
  page_id: string
  project_id: string
  timestamp: number
  usd_amount: string
  wallet_address: string
}

/** Call-site options for tracking an event (all fields optional). */
export interface TrackOptions {
  /** Validated financial metrics for the first-party collector only. */
  collector?: import('./collector-metrics.ts').CollectorMetrics
  /** Controlled chain family; defaults to Zcash for legacy call sites. */
  chain?: import('./constants.ts').AnalyticsChain
  /** Scoped to the event name; used locally for channel deduplication and never uploaded. */
  idempotencyKey?: string
  /** Filtered by the event-specific allowlist before leaving the extension */
  params?: Record<string, unknown>
  /** Filtered by the event-specific allowlist before leaving the extension */
  extra?: Record<string, unknown>
  /** Defaults to the current popup page, or `noir_background` in the SW */
  pageId?: string
  /** Transaction-related context; the event name determines its lifecycle stage */
  hasTransaction?: 0 | 1
  inputSymbol?: string
  outputSymbol?: string
}

export type AnalyticsMessage =
  | {
      type: 'ANALYTICS_EVENT'
      name: string
      options?: TrackOptions
      timestamp?: number
      engagementTimeMsec?: number
    }
  | {
      type: 'ANALYTICS_PAGE_VIEW'
      page: string
      timestamp?: number
      engagementTimeMsec?: number
    }
