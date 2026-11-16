import { useState } from 'react'
import { Icon } from '@iconify/react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import type { RheaSwapQuoteMode } from '@/core/services/rhea-swap'

export function SwapSettingsButton({
  onClick,
  disabled = false
}: {
  readonly onClick: () => void
  readonly disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Swap settings"
      title="Swap settings"
      className="wallet-interactive flex size-8 items-center justify-center rounded-lg text-muted hover:bg-accent hover:text-foreground disabled:opacity-40"
    >
      <Icon icon="lucide:settings-2" width={18} height={18} />
    </button>
  )
}

export function SlippageSettingContent({
  currentSlippage,
  currentQuoteMode,
  minimumSlippage = 0,
  maximumSlippage = 50,
  presets = [0.5, 1, 2, 3],
  onSave
}: {
  currentSlippage: number
  currentQuoteMode?: RheaSwapQuoteMode
  minimumSlippage?: number
  maximumSlippage?: number
  presets?: readonly number[]
  onSave: (slippage: number, quoteMode?: RheaSwapQuoteMode) => void
}) {
  const [slippage, setSlippage] = useState(currentSlippage.toString())
  const [quoteMode, setQuoteMode] = useState<RheaSwapQuoteMode>(currentQuoteMode ?? 'best-price')
  const parsedSlippage = Number(slippage)
  const validSlippage =
    /^\d+(?:\.\d{1,2})?$/.test(slippage) &&
    Number.isFinite(parsedSlippage) &&
    parsedSlippage >= minimumSlippage &&
    parsedSlippage <= maximumSlippage

  return (
    <div className="py-4">
      {currentQuoteMode && (
        <div className="mb-5">
          <div className="mb-2 text-sm font-medium">Request mode</div>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Request mode">
            {(
              [
                ['fast', 'Fast', 'Faster quote response'],
                ['best-price', 'Best Price', 'Wait longer for a better quote']
              ] as const
            ).map(([mode, label, description]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={quoteMode === mode}
                onClick={() => setQuoteMode(mode)}
                className={`min-h-20 rounded-lg border p-3 text-left transition-colors ${
                  quoteMode === mode
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:bg-white/10'
                }`}
              >
                <span className="flex items-center justify-between gap-1 text-sm font-medium">
                  {label}
                  <Icon
                    icon="lucide:check"
                    width={15}
                    height={15}
                    className={quoteMode === mode ? 'text-primary' : 'invisible'}
                    aria-hidden="true"
                  />
                </span>
                <span className="mt-1 block text-xs leading-4 text-muted">{description}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-2 text-sm font-medium">Slippage tolerance</div>

      <div className="flex gap-2 mb-4">
        {presets.map(preset => (
          <button
            key={preset}
            onClick={() => setSlippage(preset.toString())}
            className={`min-w-12 flex-1 shrink-0 py-2 rounded-lg text-sm font-medium transition-colors ${
              parseFloat(slippage) === preset
                ? 'bg-primary text-black'
                : 'bg-card text-white hover:bg-white/10'
            }`}
          >
            {preset}%
          </button>
        ))}
        <Input
          type="text"
          value={slippage}
          onChange={e => setSlippage(e.target.value.replace(/[^0-9.]/g, ''))}
          className="bg-card rounded-lg border-none text-center pr-6"
          classNames={{ wrapper: 'w-auto' }}
          endContent={<span className="text-sm text-muted">%</span>}
        />
      </div>
      {!validSlippage && (
        <p className="mb-3 text-xs text-destructive">
          Enter {minimumSlippage} to {maximumSlippage} with up to 2 decimals.
        </p>
      )}

      <Button
        onClick={() => onSave(parsedSlippage, currentQuoteMode ? quoteMode : undefined)}
        disabled={!validSlippage}
        className="w-full h-[50px] bg-primary hover:bg-primary/90 text-black font-semibold rounded-xl"
      >
        Save
      </Button>
    </div>
  )
}
