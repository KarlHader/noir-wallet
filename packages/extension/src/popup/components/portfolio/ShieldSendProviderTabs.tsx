import type { ShieldProvider } from '@/popup/services/asset-domains'
import { ShieldProviderLogo } from './shield-providers'

export function ShieldSendProviderTabs({
  value,
  onChange,
  disabled = false,
  availableProviders = ['near-confidential', 'zcash-shield']
}: {
  readonly value: ShieldProvider
  readonly onChange: (provider: ShieldProvider) => void
  readonly disabled?: boolean
  readonly availableProviders?: readonly ShieldProvider[]
}) {
  return (
    <div className="grid grid-cols-2 border-b border-white/10" aria-label="Shield provider">
      {(['near-confidential', 'zcash-shield'] as const).map(provider => (
        <button
          key={provider}
          type="button"
          aria-pressed={value === provider}
          disabled={disabled || !availableProviders.includes(provider)}
          onClick={() => onChange(provider)}
          className={`wallet-interactive relative flex h-12 min-w-0 items-center justify-center gap-2 px-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-45 ${value === provider ? 'text-foreground after:absolute after:inset-x-1/4 after:bottom-0 after:h-0.5 after:bg-foreground' : 'text-muted hover:text-foreground'}`}
        >
          <ShieldProviderLogo provider={provider} size={20} />
          {provider === 'near-confidential' ? 'Confidential' : 'Zcash'}
        </button>
      ))}
    </div>
  )
}
