import * as React from 'react'

import { cn } from '@/lib/utils'

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & {
    startContent?: React.ReactNode
    endContent?: React.ReactNode
    classNames?: Partial<Record<'input' | 'wrapper' | 'startContent' | 'endContent', string>>
  }
>(({ className, type, startContent, endContent, classNames, ...props }, ref) => {
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useImperativeHandle(ref, () => inputRef.current!)

  const hasWrapper = startContent || endContent

  if (hasWrapper) {
    return (
      <div className={cn('relative w-full', classNames?.wrapper)}>
        {startContent && (
          <div
            className={cn(
              'absolute left-3 top-1/2 -translate-y-1/2 flex items-center text-muted-foreground z-10',
              classNames?.startContent
            )}
          >
            {startContent}
          </div>
        )}
        <input
          ref={inputRef}
          type={type}
          data-slot="input"
          className={cn(
            'wallet-interactive file:text-foreground placeholder:text-muted-foreground/50 selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium enabled:hover:border-foreground/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive aria-invalid:enabled:hover:border-destructive',
            startContent && 'pl-10',
            endContent && 'pr-16',
            className,
            classNames?.input
          )}
          {...props}
        />
        {endContent ? (
          <div
            className={cn(
              'absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2 z-10',
              classNames?.endContent
            )}
          >
            {endContent}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <input
      ref={inputRef}
      type={type}
      data-slot="input"
      className={cn(
        'wallet-interactive file:text-foreground placeholder:text-muted-foreground/50 selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium enabled:hover:border-foreground/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive aria-invalid:enabled:hover:border-destructive',
        className
      )}
      {...props}
    />
  )
})
Input.displayName = 'Input'

export { Input }
