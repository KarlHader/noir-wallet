import type { ComponentProps } from 'react'
import { Button } from '@/popup/components/ui/button'
import { cn } from '@/lib/utils'

/** Full-width page action shared by every page of the multisig tab flow. */
export function FlowButton({
  variant = 'default',
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      variant={variant}
      className={cn('w-full h-[45px] text-base', variant === 'default' && 'text-black', className)}
      {...props}
    />
  )
}
