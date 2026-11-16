import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  size?: 'default' | 'md' | 'sm'
  className?: string
}

function Switch({ checked, size = 'default', className }: SwitchProps) {
  const isSmall = size === 'sm'

  return (
    <span
      aria-hidden="true"
      data-slot="switch"
      data-state={checked ? 'checked' : 'unchecked'}
      className={cn(
        'wallet-interactive relative inline-flex shrink-0 rounded-full',
        isSmall ? 'h-5 w-9' : size === 'md' ? 'h-6 w-10' : 'h-6 w-11',
        checked ? 'bg-primary' : 'bg-white/10',
        className
      )}
    >
      <span
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none absolute left-0.5 top-0.5 rounded-full bg-white shadow-sm transition-transform duration-[160ms] ease-out motion-reduce:transition-none',
          isSmall ? 'size-4' : 'size-5',
          checked ? (size === 'default' ? 'translate-x-5' : 'translate-x-4') : 'translate-x-0'
        )}
      />
    </span>
  )
}

export { Switch }
