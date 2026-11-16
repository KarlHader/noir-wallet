import nearLogo from '@/images/figma-near-confidential.svg'
import zcashLogo from '@/images/figma-zcash-shield.svg'
import type { ShieldProvider } from '@/popup/services/asset-domains'

export const SHIELD_PROVIDERS: Readonly<
  Record<ShieldProvider, { name: string; detailName: string; logo: string; tint: string }>
> = {
  'near-confidential': {
    name: 'NEAR Confidential',
    detailName: 'NEAR Confidential Intents',
    logo: nearLogo,
    tint: '#0c6e57'
  },
  'zcash-shield': {
    name: 'Zcash shield',
    detailName: 'Zcash shield',
    logo: zcashLogo,
    tint: '#424252'
  }
}

export function ShieldProviderLogo({
  provider,
  size = 36
}: {
  readonly provider: ShieldProvider
  readonly size?: number
}) {
  return (
    <img
      src={SHIELD_PROVIDERS[provider].logo}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="shrink-0 rounded-[5px] object-contain"
    />
  )
}
