export const GA_CONFIG = {
  measurementId: 'G-JN2QC3JP8M',
  get apiSecret(): string {
    return typeof __GA_API_SECRET__ === 'string' ? __GA_API_SECRET__ : ''
  },
  endpoint: 'https://www.google-analytics.com/mp/collect'
} as const

export const ANALYTICS_COUNTRY_ENDPOINT = 'https://rpc.zknoir.com/cdn-cgi/trace'

/**
 * Collector credentials are supplied by the release build. Values embedded
 * in an extension are visible to its users and cannot act as server secrets.
 */
export const CUSTOM_ANALYTICS_CONFIG = {
  endpoint: 'https://datareport.rhea.finance/v1/events/common',
  get cryptoPassword(): string {
    return typeof __CUSTOM_ANALYTICS_PASSWORD__ === 'string' ? __CUSTOM_ANALYTICS_PASSWORD__ : ''
  }
} as const
