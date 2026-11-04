import type { ReactNode } from 'react'

interface DemoHeaderProps {
  active: 'examples' | 'public'
  status?: ReactNode
}

export function DemoHeader({ active, status }: DemoHeaderProps) {
  return (
    <header className="header">
      <div className="header-content">
        <div className="logo">
          <a href={import.meta.env.BASE_URL} className="logo-link">
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="Noir Wallet"
              className="logo-img"
            />
            <span className="logo-text">
              <span className="logo-noir">Noir </span>
              <span className="logo-wallet">Wallet</span>
            </span>
          </a>
          <span className="logo-badge">SDK Example V2</span>
        </div>
        <nav className="demo-navigation" aria-label="Demo navigation">
          <a href="#" aria-current={active === 'examples' ? 'page' : undefined}>
            All examples
          </a>
          <a href="#noir-public" aria-current={active === 'public' ? 'page' : undefined}>
            Noir Protocol
          </a>
        </nav>
        {status && <div className="header-status">{status}</div>}
      </div>
    </header>
  )
}
