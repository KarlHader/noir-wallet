import { useState } from 'react'
import { ChainSelector } from './ChainSelector'
import { Icon } from '@iconify/react'
import { resolveChainIconAlias } from '@/lib/chain-icon'
import { ChainIcon } from './ChainIcon'
import {
  deferredChainChoices,
  selectableChainOptions
} from '@/popup/services/chain-selection-availability'

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
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label={`${ariaLabelPrefix}: ${label}`}
        onClick={() => setOpen(true)}
        className="wallet-interactive flex h-8 min-w-[117px] max-w-[190px] items-center justify-between gap-3 rounded-full bg-accent px-3.5 text-[13px] text-muted hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selectedOption && (
            <ChainIcon
              chain={resolveChainIconAlias(
                selectedOption.family,
                selectedOption.displayName,
                selectedOption.id
              )}
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

      <ChainSelector
        open={open}
        onOpenChange={setOpen}
        selectedId={selectedId}
        onSelect={value => onSelectionChange(value === 'all' ? availableIds : [value])}
        options={[
          { id: 'all', name: 'All networks' },
          ...selectableOptions.map(option => ({
            id: option.id,
            name: option.displayName,
            icon: resolveChainIconAlias(option.family, option.displayName, option.id)
          })),
          ...deferredChainChoices(__ENABLED_CHAIN_FEATURE_FLAGS__).map(option => ({
            id: `coming-soon:${option.family}`,
            name: option.label,
            icon: option.iconAlias,
            disabled: true,
            note: 'Coming soon'
          }))
        ]}
      />
    </>
  )
}
