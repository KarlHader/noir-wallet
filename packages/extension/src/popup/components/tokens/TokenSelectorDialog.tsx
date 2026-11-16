import type { ReactNode } from 'react'
import { PageHeader } from '../common/PageHeader'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

export const tokenSelectorDialogClassName =
  '!inset-0 !h-dvh !max-h-dvh !w-full !max-w-none !translate-x-0 !translate-y-0 !rounded-none !border-0 !p-0 !gap-0 flex flex-col bg-background shadow-none'

export function TokenSelectorContent({
  title = 'Select Token',
  onBack,
  children
}: {
  readonly title?: string
  readonly onBack: () => void
  readonly children: ReactNode
}) {
  return (
    <>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <PageHeader title={title} showBack onBack={onBack} />
      <div className="min-h-0 flex-1 px-4 pb-2">{children}</div>
    </>
  )
}

export function TokenSelectorDialog({
  open,
  onOpenChange,
  title = 'Select Token',
  walletMode,
  children
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly title?: string
  readonly walletMode?: 'private' | 'public'
  readonly children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        position="bottom"
        showCloseButton={false}
        data-wallet-mode={walletMode}
        className={tokenSelectorDialogClassName}
      >
        <DialogDescription className="sr-only">Choose an asset</DialogDescription>
        <TokenSelectorContent title={title} onBack={() => onOpenChange(false)}>
          {children}
        </TokenSelectorContent>
      </DialogContent>
    </Dialog>
  )
}
