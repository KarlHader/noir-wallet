import { useEffect, useState } from 'react'
import { getNoirWallet } from '@noir-wallet/sdk'
import { PublicDemo } from './noir-protocol/public/PublicDemo'
import './App.css'

export function PublicDemoApp() {
  const [wallet, setWallet] = useState(() => getNoirWallet())
  useEffect(() => {
    const update = () => setWallet(current => current ?? getNoirWallet())
    window.addEventListener('noirwallet#initialized', update)
    update()
    return () => window.removeEventListener('noirwallet#initialized', update)
  }, [])

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <a className="logo-link" href="#">
            Noir Wallet SDK
          </a>
          <span className="logo-badge">Developer demo</span>
        </div>
      </header>
      <main className="main">
        <section className="page-intro">
          <div>
            <p className="eyebrow">Zcash L2 / Public</p>
            <h1>Noir Protocol</h1>
          </div>
          <a className="btn btn-secondary btn-xs" href="#">
            All examples
          </a>
        </section>
        {wallet ? (
          <PublicDemo client={wallet.zcash} walletVersion={wallet.version} />
        ) : (
          <section className="card install-prompt">
            <h2>Wallet not detected</h2>
            <p>Load the Noir Wallet extension, then reload this page.</p>
          </section>
        )}
      </main>
    </div>
  )
}
