import { Icon } from '@iconify/react'
import { Button } from '../ui/button'
import { openModal } from '../../provider/ModalManager'
import { formatTokenQuantity } from '@/lib/number-format'
import { hasEnoughTransparentBalanceToShield } from '@/core/zcash/shielding'

function WhyMigrateContent() {
  const benefits = [
    {
      icon: '🔒',
      title: 'Full privacy',
      description: 'z-address transactions hide amounts and participants'
    },
    {
      icon: '🎯',
      title: 'Selective disclosure',
      description: 'You can choose what transaction details to reveal'
    },
    {
      icon: '🛡️',
      title: 'Enhanced security',
      description: 'Protected against blockchain surveillance'
    }
  ]

  return (
    <div className="px-3 py-4">
      <div className="space-y-5">
        {benefits.map(benefit => (
          <div key={benefit.title} className="flex gap-4">
            <div className="text-base shrink-0 w-6 h-6 flex items-center justify-center">
              {benefit.icon}
            </div>
            <div className="flex-1">
              <h4 className="font-medium mb-1 text-base">{benefit.title}</h4>
              <p className="text-sm text-muted leading-relaxed">{benefit.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

interface ShieldFundsBannerProps {
  transparentBalance: number
  action?: string
  isShielding: boolean
  onShield: () => void
}

export function ShieldFundsBanner({
  transparentBalance,
  action = 'send',
  isShielding,
  onShield
}: ShieldFundsBannerProps) {
  if (!hasEnoughTransparentBalanceToShield(transparentBalance)) return null

  const handleWhyMigrate = async () => {
    await openModal({
      title: 'Why shielded?',
      showCloseButton: true,
      body: () => <WhyMigrateContent />
    })
  }

  const actionVerb = action === 'send' ? 'send' : action === 'supply' ? 'supply' : 'spend'

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-warning/10 rounded-lg border border-warning/20 mb-4">
      <Icon icon="lucide:alert-triangle" width={14} height={14} className="text-warning shrink-0" />
      <p className="flex-1 min-w-0 text-xs text-warning leading-snug">
        <strong>{formatTokenQuantity(transparentBalance)} ZEC</strong> in transparent — shield to{' '}
        {actionVerb}.
        <button
          type="button"
          onClick={handleWhyMigrate}
          className="ml-1 underline decoration-dotted underline-offset-2 hover:opacity-80"
        >
          Why?
        </button>
      </p>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs px-2.5 shrink-0 border-warning/30 text-warning hover:bg-warning/30 hover:border-warning/40 hover:text-warning/80"
        onClick={onShield}
        isLoading={isShielding}
      >
        Shield
      </Button>
    </div>
  )
}
