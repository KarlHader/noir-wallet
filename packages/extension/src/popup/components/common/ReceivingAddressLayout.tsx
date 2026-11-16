import type { ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { QRCodeSVG } from 'qrcode.react'

interface ReceivingAddressLayoutProps {
  readonly onClose: () => void
  readonly title?: string
  readonly identity?: ReactNode
  readonly headerAction?: ReactNode
  readonly beforeQr?: ReactNode
  readonly qrValue?: string
  readonly qrLabel?: string
  readonly qrSize?: number
  readonly warning?: ReactNode
  readonly children?: ReactNode
  readonly footer?: ReactNode
}

export function ReceivingAddressLayout({
  onClose,
  title = 'Receiving Address',
  identity,
  headerAction,
  beforeQr,
  qrValue,
  qrLabel = 'Receiving address QR code',
  qrSize = 208,
  warning,
  children,
  footer
}: ReceivingAddressLayoutProps) {
  return (
    <div
      role="region"
      aria-label={title}
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
    >
      <header className="relative flex h-14 shrink-0 items-center justify-center px-12">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close receiving address"
          className="wallet-interactive absolute left-3 flex size-8 items-center justify-center rounded-lg text-foreground hover:bg-accent active:brightness-90 focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <Icon icon="lucide:x" width={20} height={20} />
        </button>
        <h1 className="truncate text-lg font-medium leading-[23px]">{title}</h1>
        {headerAction && <div className="absolute right-3">{headerAction}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
        <div className="mx-auto flex w-full max-w-[440px] flex-col items-center">
          {identity && (
            <div className="mt-6 flex w-full items-center justify-center">{identity}</div>
          )}
          {beforeQr && <div className="mt-5 w-full">{beforeQr}</div>}
          {qrValue && (
            <div className="mt-6 rounded-lg bg-white p-3">
              <QRCodeSVG
                value={qrValue}
                size={qrSize}
                level="M"
                includeMargin={false}
                aria-label={qrLabel}
              />
            </div>
          )}
          {warning && <div className="mt-4 w-full text-sm leading-5 text-warning">{warning}</div>}
          {children}
        </div>
      </div>
      {footer && <div className="shrink-0 px-4 pb-4">{footer}</div>}
    </div>
  )
}
