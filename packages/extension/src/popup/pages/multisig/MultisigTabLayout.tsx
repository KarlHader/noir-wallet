import type { ReactNode } from 'react'
import { PageHeader } from '@/popup/components/common/PageHeader'
import { StepBars } from '@/popup/components/multisig/StepBars'
import { DevPanel } from '@/popup/multisig/mock/DevPanel'

interface MultisigTabLayoutProps {
  /** Position in the three-step create flow; null on pages outside it (failed, team). */
  step: 1 | 2 | 3 | null
  title: string
  onBack?: () => void
  showBack?: boolean
  children: ReactNode
  footer?: ReactNode
}

/** Full-tab shell shared by every multisig page: header, optional progress bars, content, footer. */
export function MultisigTabLayout({
  step,
  title,
  onBack,
  showBack = true,
  children,
  footer
}: MultisigTabLayoutProps) {
  return (
    <div className="page-container page-container--tab">
      <PageHeader title={title} showBack={showBack} onBack={onBack} />
      {step !== null && (
        // The tab layout only centers the header, content and footer, so this row repeats the
        // 440px column to stay aligned with them.
        <div className="mx-auto w-full max-w-[440px] shrink-0 px-5 pb-2 pt-4">
          <StepBars total={3} current={step} />
        </div>
      )}
      <div className="page-content">{children}</div>
      {footer && <div className="page-footer">{footer}</div>}
      <DevPanel />
    </div>
  )
}
