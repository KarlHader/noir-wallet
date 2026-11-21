import { Icon } from '@iconify/react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

export function ZcashBroadcastHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="About Zcash private broadcast"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Icon icon="lucide:circle-help" className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        collisionPadding={16}
        className="max-h-[min(28rem,70vh)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto space-y-3 text-xs leading-5"
      >
        <p>
          ZeroIndexer can relay transactions containing Orchard and check their status with extra
          network privacy. If the endpoint fails, Noir falls back to the regular Zcash node.
        </p>
        <p>Auto selects a node for you. You can also choose a trusted node.</p>
      </PopoverContent>
    </Popover>
  )
}
