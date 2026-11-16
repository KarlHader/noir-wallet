import { Icon } from '@iconify/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/popup/components/ui/dropdown-menu'

type SendRoute = 'onchain' | 'cross-chain'

export function SendRouteMenu({
  route,
  onChange
}: {
  route: SendRoute
  onChange: (route: SendRoute) => void
}) {
  const label = route === 'onchain' ? 'Same-chain' : 'Cross-chain'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Send route, current ${label}`}
          title="Send route"
          className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs text-muted transition-colors hover:bg-card hover:text-foreground"
        >
          <Icon icon="lucide:route" width={15} height={15} />
          <span>{label}</span>
          <Icon icon="lucide:chevron-down" width={12} height={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup
          value={route}
          onValueChange={value => {
            if (value === 'onchain' || value === 'cross-chain') onChange(value)
          }}
        >
          <DropdownMenuRadioItem value="onchain">Same-chain</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="cross-chain">Cross-chain</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
