/**
 * A sample draw result, to review the result dialog where there is no real entry to reveal:
 * /campaign?reveal-demo=win or ?reveal-demo=lose. Branch previews (*.noir-wallet.pages.dev) and
 * local development only; the live site and the production pages.dev address ignore it.
 */
import type { ShieldWinEntry } from './api'

const PREVIEW_HOST = /^(?:[a-z0-9-]+\.noir-wallet\.pages\.dev|localhost|127\.0\.0\.1)$/

export function revealDemoEntry(
  hostname: string,
  search: string,
  now = Date.now()
): ShieldWinEntry | null {
  if (!PREVIEW_HOST.test(hostname)) return null
  const kind = new URLSearchParams(search).get('reveal-demo')
  if (kind !== 'win' && kind !== 'lose') return null
  const sample = {
    id: 0,
    operation_id: 0,
    campaign_id: 0,
    destination_asset: 'nep141:eth.omft.near',
    usd_value: '12.40',
    shield_completed_at: now
  }
  return kind === 'win'
    ? {
        ...sample,
        draw_result: 'WON',
        reward_amount: '0.1',
        reward_asset: 'ZEC',
        reward_status: 'UNCLAIMED'
      }
    : { ...sample, draw_result: 'NOT_WON' }
}
