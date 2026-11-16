import { MNEMONIC_WORD_COUNTS, type MnemonicWordCount } from '@/config/wallet'
import { cn } from '@/lib/utils'

interface MnemonicWordCountSelectorProps {
  value: MnemonicWordCount
  onChange: (wordCount: MnemonicWordCount) => void
}

/** Selects one of the product-supported canonical recovery phrase lengths. */
export function MnemonicWordCountSelector({ value, onChange }: MnemonicWordCountSelectorProps) {
  return (
    <div role="radiogroup" aria-label="Recovery phrase length" className="grid grid-cols-2 gap-3">
      {MNEMONIC_WORD_COUNTS.slice()
        .reverse()
        .map(wordCount => {
          const selected = value === wordCount

          return (
            <button
              key={wordCount}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(wordCount)}
              className={cn(
                'h-12 rounded-lg border flex items-center gap-3 px-4 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                selected
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-white/10 bg-card text-muted hover:bg-accent'
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-4 rounded-full border-2 flex items-center justify-center shrink-0',
                  selected ? 'border-primary' : 'border-muted'
                )}
              >
                {selected && <span className="size-2 rounded-full bg-primary" />}
              </span>
              <span className={cn('text-sm', selected ? 'font-medium' : 'font-normal')}>
                {wordCount} words
              </span>
            </button>
          )
        })}
    </div>
  )
}
