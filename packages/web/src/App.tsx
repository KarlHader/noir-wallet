import { lazy, Suspense, useEffect } from 'react'
import { ZendeskControls } from './components/ZendeskControls'
import { Site } from './home/Site'

const FrostVotePage = lazy(() => import('./pages/FrostVotePage'))
const V2BetaPage = lazy(() => import('./pages/V2BetaPage'))
const ShieldAndWinPage = lazy(() => import('./pages/ShieldAndWinPage'))

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

export default function App() {
  const path = normalizePath(window.location.pathname)
  const redirectUrl =
    path === '/github'
      ? __WALLET_REPOSITORY_URL__
      : path === '/beta' || path === '/beta/versions'
        ? __WALLET_RELEASES_URL__
        : null

  useEffect(() => {
    if (redirectUrl) {
      window.location.replace(redirectUrl)
    }
  }, [redirectUrl])

  if (redirectUrl) {
    return null
  }

  let page = <Site />
  if (path === '/frost') {
    page = (
      <Suspense fallback={<div className="min-h-screen bg-bg" />}>
        <FrostVotePage />
      </Suspense>
    )
  } else if (path === '/v2/beta') {
    page = (
      <Suspense fallback={<div className="min-h-screen bg-bg" />}>
        <V2BetaPage />
      </Suspense>
    )
  } else if (path === '/shield-and-win') {
    page = (
      <Suspense fallback={<div style={{ minHeight: '100vh', background: '#000' }} />}>
        <ShieldAndWinPage />
      </Suspense>
    )
  }

  return (
    <>
      {page}
      <ZendeskControls />
    </>
  )
}
