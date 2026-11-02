import { lazy, Suspense, useEffect } from 'react'
import { LandingPage } from './pages/LandingPage'

const FrostVotePage = lazy(() => import('./pages/FrostVotePage'))
const V2BetaPage = lazy(() => import('./pages/V2BetaPage'))

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

  if (path === '/frost') {
    return (
      <Suspense fallback={<div className="min-h-screen bg-bg" />}>
        <FrostVotePage />
      </Suspense>
    )
  }

  if (path === '/v2/beta') {
    return (
      <Suspense fallback={<div className="min-h-screen bg-bg" />}>
        <V2BetaPage />
      </Suspense>
    )
  }

  return <LandingPage />
}
