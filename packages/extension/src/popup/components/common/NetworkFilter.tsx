import { Icon } from '@iconify/react'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { ChainIcon } from './ChainIcon'
import {
  deferredChainChoices,
  selectableChainOptions
} from '@/popup/services/chain-selection-availability'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export interface NetworkFilterOption {
  readonly id: string
  readonly family: string
  readonly displayName: string
}

interface NetworkFilterProps {
  readonly ariaLabelPrefix: string
  readonly options: readonly NetworkFilterOption[]
  readonly selectedIds: readonly string[]
  readonly onSelectionChange: (selectedIds: readonly string[]) => void
}

export function NetworkFilter({
  ariaLabelPrefix,
  options,
  selectedIds,
  onSelectionChange
}: NetworkFilterProps) {
  const selectableOptions = selectableChainOptions(options, __ENABLED_CHAIN_FEATURE_FLAGS__)
  const availableIds = selectableOptions.map(option => option.id)
  const selectedIdSet = new Set(selectedIds)
  const normalizedSelectedIds = availableIds.filter(id => selectedIdSet.has(id))
  const selectedId = normalizedSelectedIds.length === 1 ? normalizedSelectedIds[0] : 'all'
  const selectedOption = selectableOptions.find(option => option.id === selectedId)
  const label = selectedOption?.displayName ?? 'All networks'
  const renderOption = (option: NetworkFilterOption) => (
    <DropdownMenuRadioItem key={option.id} value={option.id} className="cursor-pointer py-2">
      <ChainIcon
        chain={resolveChainIconAlias(option.family, option.displayName, option.id)}
        width={16}
        height={16}
        className="rounded-[4px]"
        showTooltip={false}
        alt=""
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-sm">{option.displayName}</span>
    </DropdownMenuRadioItem>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${ariaLabelPrefix}: ${label}`}
          className="wallet-interactive flex h-8 min-w-[117px] max-w-[190px] items-center justify-between gap-3 rounded-full bg-accent px-3.5 text-[13px] text-muted hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {selectedOption && (
              <ChainIcon
                chain={resolveChainIconAlias(selectedOption.family, selectedOption.displayName)}
                width={16}
                height={16}
                className="shrink-0 rounded-[4px]"
                showTooltip={false}
                alt=""
                aria-hidden="true"
              />
            )}
            <span className="truncate">{label}</span>
          </span>
          <Icon icon="lucide:chevron-down" width={13} height={13} className="text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] min-w-[230px]">
        <DropdownMenuRadioGroup
          value={selectedId}
          onValueChange={value => onSelectionChange(value === 'all' ? availableIds : [value])}
        >
          <DropdownMenuRadioItem value="all" className="cursor-pointer py-2">
            <Icon icon="lucide:network" width={16} height={16} className="text-muted" />
            <span className="min-w-0 flex-1 truncate text-sm">All networks</span>
          </DropdownMenuRadioItem>
          {selectableOptions.map(renderOption)}
          {deferredChainChoices(__ENABLED_CHAIN_FEATURE_FLAGS__).map(option => (
            <DropdownMenuRadioItem
              key={option.family}
              value={`coming-soon:${option.family}`}
              disabled
              className="py-2 text-muted data-[disabled]:opacity-100"
            >
              <ChainIcon
                chain={option.iconAlias}
                width={16}
                height={16}
                className="rounded-[4px]"
                showTooltip={false}
                alt=""
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate text-sm">{option.label}</span>
              <span className="text-[10px]">Coming soon</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
