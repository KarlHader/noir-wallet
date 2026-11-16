import { Icon } from '@iconify/react'
import { Button } from '../ui/button'
import { CopyFeedbackIcon } from '../common/CopyToast'

interface SeedPhraseDisplayProps {
  words: string[]
  blurred?: boolean
  onReveal?: () => void
  onCopy?: () => void
  copied?: boolean
}

export function SeedPhraseDisplay({
  words,
  blurred,
  onReveal,
  onCopy,
  copied = false
}: SeedPhraseDisplayProps) {
  return (
    <div className="relative group">
      <div
        aria-hidden={blurred ? true : undefined}
        className={`grid grid-cols-2 min-[520px]:grid-cols-3 gap-3 p-4 bg-black/40 rounded-xl border border-white/10 transition-all duration-300 ${
          blurred ? 'blur-md select-none' : ''
        }`}
      >
        {words.map((word, index) => (
          <div key={index} className="relative flex min-w-0 items-center">
            <span className="absolute left-3 text-xs text-muted select-none">{index + 1}.</span>
            <div className="w-full min-w-0 py-2.5 pl-8 pr-2 bg-card rounded-lg text-sm font-medium text-center border border-transparent">
              {blurred ? '------' : word}
            </div>
          </div>
        ))}
      </div>

      {blurred && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
          <div className="flex flex-col items-center gap-3">
            <Button
              variant="ghost"
              onClick={onReveal}
              className="flex flex-col items-center gap-3 text-white hover:text-primary hover:bg-transparent"
            >
              <div className="flex-shrink-0 w-12 h-12 rounded-full bg-white/5 flex items-center justify-center backdrop-blur-sm">
                <Icon icon="lucide:eye-off" width={20} height={20} className="text-muted" />
              </div>
              Click to reveal seed phrase
            </Button>
          </div>
        </div>
      )}

      {onCopy && (
        <div className="absolute -top-3 right-4 z-20">
          <Button
            variant="outline"
            size="sm"
            onClick={onCopy}
            className="flex items-center gap-2 h-8 bg-background border-border hover:bg-card text-xs"
          >
            <CopyFeedbackIcon copied={copied} width={12} height={12} />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </div>
  )
}
