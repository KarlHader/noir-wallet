import { useState } from 'react'
import { Icon } from '@iconify/react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { TransactionNotice } from '../transaction/TransactionNotice'
import { DialogFooter } from '../ui/dialog'
import type { RheaSwapQuoteMode } from '@/core/services/rhea-swap'
import { useSwapPreferences, type SwapQuoteSettings } from '@/store/swap-store'
import { openModal } from '@/popup/provider/ModalManager'

export function SwapSettingsButton({
  onChange,
  disabled = false
}: {
  readonly onChange?: () => void
  readonly disabled?: boolean
}) {
  const openSettings = () => {
    const { slippage, quoteMode, setQuoteSettings } = useSwapPreferences.getState()
    void openModal({
      title: 'Swap Settings',
      showCloseButton: true,
      body: (_resolve, close) => (
        <SwapSettingsContent
          currentSlippage={slippage}
          currentQuoteMode={quoteMode}
          onSave={settings => {
            const current = useSwapPreferences.getState()
            if (
              settings.slippage !== current.slippage ||
              settings.quoteMode !== current.quoteMode
            ) {
              onChange?.()
              setQuoteSettings(settings)
            }
            close()
          }}
        />
      )
    })
  }
  return (
    <button
      type="button"
      onClick={openSettings}
      disabled={disabled}
      aria-label="Swap settings"
      title="Swap settings"
      className="wallet-interactive flex size-8 items-center justify-center rounded-lg text-muted hover:bg-accent hover:text-foreground disabled:opacity-40"
    >
      <Icon icon="lucide:settings-2" width={18} height={18} />
    </button>
  )
}

function SwapSettingsContent({
  currentSlippage,
  currentQuoteMode,
  onSave
}: {
  currentSlippage: number
  currentQuoteMode: RheaSwapQuoteMode
  onSave: (settings: SwapQuoteSettings) => void
}) {
  const [slippage, setSlippage] = useState(currentSlippage.toString())
  const [quoteMode, setQuoteMode] = useState(currentQuoteMode)
  const parsedSlippage = Number(slippage)
  const validSlippage =
    /^\d+(?:\.\d{1,2})?$/.test(slippage) &&
    Number.isFinite(parsedSlippage) &&
    parsedSlippage >= 0 &&
    parsedSlippage <= 50

  return (
    <div className="py-4">
      <div className="mb-5">
        <div className="mb-2 text-sm font-medium">Request mode</div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Request mode">
          {(
            [
              ['best-price', 'Best Price', 'Wait longer for a better quote'],
              ['fast', 'Fast', 'Faster quote response']
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

      <div className="mb-2 text-sm font-medium">Slippage tolerance</div>

      <div className="flex gap-2 mb-4">
        {[0.5, 1, 2, 3].map(preset => (
          <button
            key={preset}
            onClick={() => setSlippage(preset.toString())}
            className={`min-w-0 flex-1 px-1 py-2 rounded-lg text-sm font-medium transition-colors ${
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
          aria-label="Slippage tolerance"
          aria-invalid={!validSlippage || undefined}
          aria-describedby={!validSlippage ? 'swap-settings-slippage-error' : undefined}
          value={slippage}
          onChange={e => setSlippage(e.target.value.replace(/[^0-9.]/g, ''))}
          className="bg-card rounded-lg border-none text-center pr-6"
          classNames={{ wrapper: 'min-w-16 basis-1/3' }}
          endContent={<span className="text-sm text-muted">%</span>}
        />
      </div>
      {!validSlippage && (
        <TransactionNotice
          id="swap-settings-slippage-error"
          className="mb-3"
          message="Enter 0 to 50 with up to 2 decimals."
        />
      )}

      <DialogFooter>
        <Button
          onClick={() => onSave({ slippage: parsedSlippage, quoteMode })}
          disabled={!validSlippage}
        >
          Save
        </Button>
      </DialogFooter>
    </div>
  )
}
