import { useEffect, useState } from 'react'
import { getNoirWallet } from '@noir-wallet/sdk'
import { PublicDemo } from './noir-protocol/public/PublicDemo'
import { DemoHeader } from './DemoHeader'
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
      <DemoHeader active="public" />
      <main className="main">
        <section className="page-intro">
          <div>
            <p className="eyebrow">Multichain / Public</p>
            <h1>Noir Protocol</h1>
          </div>
        </section>
        {wallet ? (
          <PublicDemo wallet={wallet} />
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
