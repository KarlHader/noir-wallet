interface ApprovalWindowLayoutProps {
  children: React.ReactNode
  footer: React.ReactNode
}

export function ApprovalWindowLayout({ children, footer }: ApprovalWindowLayoutProps) {
  return (
    <div className="page-container">
      <div
        data-testid="approval-scroll-region"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-6"
      >
        {children}
      </div>
      <footer
        data-testid="approval-footer"
        className="shrink-0 border-t border-border bg-background/95 p-5 shadow-lg backdrop-blur-md"
      >
        {footer}
      </footer>
    </div>
  )
}
