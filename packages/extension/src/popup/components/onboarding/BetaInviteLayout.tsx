import type { ReactNode } from 'react'
import WalletIcon from '@/images/wallet-icon.svg'
import { PageHeader } from '../common/PageHeader'

export function BetaInviteLayout({
  title,
  children,
  footer
}: {
  title: string
  children?: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="page-container mx-auto bg-background" style={{ minHeight: 0 }}>
        <PageHeader />
        <main className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-8">
          <div className="mb-6">
            <img src={WalletIcon} alt="Noir Wallet" />
          </div>
          <h1 className="mb-2 text-center text-lg font-semibold">{title}</h1>
          <div className="w-full max-w-sm">{children}</div>
        </main>
        {footer && <div className="shrink-0 space-y-3 px-5 pb-5">{footer}</div>}
      </div>
    </div>
  )
}
