import { Checkbox } from '../ui/checkbox'
import { Icon } from '@iconify/react'
import { ChainIcon } from '../common/ChainIcon'
import type { AccountNetworkFamily } from '@/core/wallet/account-network-selection'
import { formatSortAddress } from '@/lib/format'
import { cn } from '@/lib/utils'

const FAMILY_LABELS: Record<AccountNetworkFamily, string> = {
  zcash: 'Zcash',
  evm: 'Ethereum & EVM',
  bitcoin: 'Bitcoin',
  solana: 'Solana',
  near: 'NEAR',
  tron: 'Tron'
}

export function AccountNetworkFamilyChoices({
  availableFamilies,
  selectedFamilies,
  initialSelectedFamilies,
  onChange,
  disabled = false,
  requireSelection = false,
  showZcashSyncWarning = false,
  addressPreviews,
  addressesLoading = false,
  hideMissingAddressPreviews = false,
  variant = 'default'
}: {
  readonly availableFamilies: readonly AccountNetworkFamily[]
  readonly selectedFamilies: readonly AccountNetworkFamily[]
  readonly initialSelectedFamilies?: readonly AccountNetworkFamily[]
  readonly onChange: (families: readonly AccountNetworkFamily[]) => void
  readonly disabled?: boolean
  readonly requireSelection?: boolean
  readonly showZcashSyncWarning?: boolean
  readonly addressPreviews?: Readonly<Partial<Record<AccountNetworkFamily, string>>>
  readonly addressesLoading?: boolean
  readonly hideMissingAddressPreviews?: boolean
  readonly variant?: 'default' | 'import' | 'management'
}) {
  const initial = initialSelectedFamilies ?? selectedFamilies
  const orderedFamilies =
    variant === 'management'
      ? [
          ...availableFamilies.filter(family => !initial.includes(family)),
          ...availableFamilies.filter(family => initial.includes(family))
        ]
      : availableFamilies
  const firstAvailable = orderedFamilies.find(family => !initial.includes(family))
  const firstCurrent = orderedFamilies.find(family => initial.includes(family))

  return (
    <div
      className={variant === 'management' ? 'space-y-2' : 'space-y-1'}
      role="group"
      aria-label="Account networks"
    >
      {orderedFamilies.map(family => {
        const checked = selectedFamilies.includes(family)
        return (
          <div key={family}>
            {variant === 'management' && family === firstAvailable && (
              <h2 className="mb-3 text-sm font-medium text-muted">Available</h2>
            )}
            {variant === 'management' && family === firstCurrent && (
              <h2 className={cn('mb-3 text-sm font-medium text-muted', firstAvailable && 'mt-6')}>
                Currently
              </h2>
            )}
            <label
              className={cn(
                'flex min-h-14 cursor-pointer items-center gap-3 rounded-md px-1 hover:bg-white/5',
                variant === 'import' && 'min-h-[66px] px-0',
                variant === 'management' &&
                  'min-h-[71px] rounded-lg bg-wallet-surface px-4 hover:bg-white/10'
              )}
            >
              {family === 'evm' ? (
                <span aria-hidden="true" className="grid size-8 shrink-0 grid-cols-2 gap-[2px]">
                  {(['eth', 'arb', 'avax', 'bsc'] as const).map(chain => (
                    <ChainIcon
                      key={chain}
                      chain={chain}
                      showTooltip={false}
                      className="size-[15px]"
                    />
                  ))}
                </span>
              ) : (
                <ChainIcon
                  chain={family}
                  showTooltip={false}
                  className="size-8 shrink-0 rounded-md"
                />
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-sm font-medium',
                    (variant === 'import' || variant === 'management') && 'text-base'
                  )}
                >
                  {FAMILY_LABELS[family]}
                </span>
                {addressPreviews &&
                  (!hideMissingAddressPreviews ||
                    addressPreviews[family] ||
                    (addressesLoading && checked)) && (
                    <span
                      className="mt-0.5 block truncate font-mono text-xs text-muted"
                      title={addressPreviews[family]}
                      aria-label={`${FAMILY_LABELS[family]} address`}
                    >
                      {addressPreviews[family]
                        ? formatSortAddress(addressPreviews[family])
                        : addressesLoading
                          ? 'Loading…'
                          : '—'}
                    </span>
                  )}
              </span>
              <Checkbox
                checked={checked}
                disabled={
                  disabled || (requireSelection && checked && selectedFamilies.length === 1)
                }
                onCheckedChange={value =>
                  onChange(
                    value === true
                      ? availableFamilies.filter(
                          item => item === family || selectedFamilies.includes(item)
                        )
                      : selectedFamilies.filter(item => item !== family)
                  )
                }
                aria-label={FAMILY_LABELS[family] ?? family}
                className={cn(
                  'size-6 rounded-md data-[state=checked]:bg-foreground data-[state=checked]:text-background data-[state=checked]:border-foreground',
                  variant === 'import' && 'size-5'
                )}
              />
            </label>
            {family === 'zcash' && showZcashSyncWarning && (
              <div
                className={cn(
                  'mb-2 mt-1 flex items-start gap-2 rounded-lg bg-warning-surface px-3 py-2.5 text-xs leading-5 text-warning',
                  variant === 'import' && 'text-sm'
                )}
              >
                <Icon
                  icon="lucide:info"
                  width={16}
                  height={16}
                  className="mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Zcash synchronization takes time. Uncheck Zcash if you don’t need it now. You can
                  add it later.
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
