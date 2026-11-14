import { type AddressType } from '@/types/wallet'

const getAddressTypeConfig = (t: AddressType) => {
  switch (t) {
    case 'shielded':
      return {
        label: 'Shielded',
        className: 'bg-[#9500FF]/40 text-[#DEAFFF]'
      }
    case 'transparent':
    default:
      return {
        label: 'Transparent',
        className: 'bg-white/10 text-white'
      }
  }
}

interface AddressTypeLabelProps {
  type: AddressType
  size?: 'sm' | 'md'
  className?: string
  children?: React.ReactNode
}

/**
 * Static address type label (Shielded/Transparent) - non-interactive display
 */
export function AddressTypeLabel({
  type,
  size = 'sm',
  className,
  children
}: AddressTypeLabelProps) {
  const sizeStyles =
    size === 'sm'
      ? 'min-w-[68px] shrink-0 whitespace-nowrap px-1.5 py-0.5 text-[10px]'
      : 'whitespace-nowrap px-3 py-1 text-xs'
  const config = getAddressTypeConfig(type)

  return (
    <span
      className={`inline-flex items-center justify-center rounded ${sizeStyles} ${config.className} ${
        className || ''
      }`}
    >
      {config.label}
      {children}
    </span>
  )
}
