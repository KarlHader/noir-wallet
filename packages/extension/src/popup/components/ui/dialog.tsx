'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'

import { cn } from '@/lib/utils'

const dialogHeightClassName = 'min-h-[min(150px,80dvh)] max-h-[80dvh]'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/70 backdrop-blur-sm',
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  position = 'center',
  scroll = 'content',
  fixedHeight = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  position?: 'center' | 'bottom'
  scroll?: 'content' | 'body'
  fixedHeight?: boolean
}) {
  const positionClasses = {
    center:
      'top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%] data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 max-w-[calc(100%-2rem)] sm:max-w-lg rounded-lg',
    bottom:
      'bottom-0 left-0 right-0 translate-x-0 translate-y-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom max-w-full rounded-t-2xl rounded-b-none border-t border-foreground/10 shadow-[0_-14px_36px_rgba(0,0,0,0.48)]'
  }
  const closeButton = showCloseButton ? (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className="ring-offset-background focus-visible:ring-ring absolute right-4 top-4 z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-inherit text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      >
        <path d="m18 6-12 12M6 6l12 12" />
      </svg>
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  ) : null

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed z-50 w-full shadow-lg duration-200 outline-none [&>*]:min-w-0',
          'flex flex-col gap-4 overflow-hidden p-6',
          positionClasses[position],
          className,
          dialogHeightClassName,
          fixedHeight && 'h-[80dvh]'
        )}
        {...props}
      >
        {scroll === 'content' ? (
          <div
            data-slot="dialog-scroll"
            className="grid min-h-0 flex-1 content-start gap-[inherit] overflow-y-auto overscroll-contain [&>*]:min-w-0"
          >
            {children}
          </div>
        ) : (
          children
        )}
        {closeButton}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'grid w-full shrink-0 auto-cols-fr grid-flow-col gap-2 [&>button]:h-11 [&>button]:min-w-0 [&>button]:whitespace-normal [&>button]:leading-tight',
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
