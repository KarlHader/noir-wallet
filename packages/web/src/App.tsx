import { lazy, Suspense, useEffect } from 'react'
import { ZendeskControls } from './components/ZendeskControls'
import { Site } from './home/Site'

const FrostVotePage = lazy(() => import('./pages/FrostVotePage'))
const V2BetaPage = lazy(() => import('./pages/V2BetaPage'))
const ShieldAndWinPage = lazy(() => import('./pages/ShieldAndWinPage'))
const FeedbackRewards = lazy(() => import('./home/FeedbackRewards'))

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

/**
 * Pages that moved within the site. Old links (posts, the wallet) still open them, and the address
 * bar switches to the new path without a reload.
 */
const MOVED_PATHS: Readonly<Record<string, string>> = {
  '/shield-and-win': '/campaign'
}

export default function App() {
  const requestedPath = normalizePath(window.location.pathname)
  const path = MOVED_PATHS[requestedPath] ?? requestedPath
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

  useEffect(() => {
    if (path !== requestedPath) {
      const { search, hash } = window.location
      window.history.replaceState(window.history.state, '', `${path}${search}${hash}`)
    }
  }, [path, requestedPath])

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
  } else if (path === '/campaign') {
    page = (
      <Suspense fallback={<div style={{ minHeight: '100vh', background: '#000' }} />}>
        <ShieldAndWinPage />
      </Suspense>
    )
  } else if (path === '/feedback-rewards') {
    page = (
      <Suspense fallback={<div style={{ minHeight: '100vh', background: '#000' }} />}>
        <FeedbackRewards />
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
