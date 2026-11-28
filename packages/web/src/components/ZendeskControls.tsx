import { useEffect, useRef, useState } from 'react'
import { createZendeskSession, installZendeskSnippet, type ZendeskApi } from '../lib/zendesk'
import './zendesk.css'

function getZendeskApi(): ZendeskApi | undefined {
  return window.zE
}

export function ZendeskControls() {
  const [isOpen, setIsOpen] = useState(false)
  const minimizeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    installZendeskSnippet()
    const session = createZendeskSession({
      getApi: getZendeskApi,
      getHref: () => window.location.href,
      onOpenChange(open) {
        document.documentElement.toggleAttribute('data-zendesk-open', open)
        setIsOpen(open)
      }
    })
    let timer: number | undefined
    if (!session.connect()) {
      timer = window.setInterval(() => {
        if (session.connect()) window.clearInterval(timer)
      }, 500)
    }
    const handlePopState = () => session.navigate()
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
      window.clearInterval(timer)
      document.documentElement.removeAttribute('data-zendesk-open')
      session.dispose()
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return

    function handleOutsidePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && minimizeButtonRef.current?.contains(event.target)) return
      // Events inside Zendesk's iframe stay in that document. Host-page
      // interactions dismiss the panel without blocking the clicked control.
      getZendeskApi()?.('messenger', 'close')
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') getZendeskApi()?.('messenger', 'close')
    }

    document.addEventListener('pointerdown', handleOutsidePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <button
      ref={minimizeButtonRef}
      type="button"
      className="zendesk-minimize"
      aria-label="Minimize support chat"
      onClick={() => getZendeskApi()?.('messenger', 'close')}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M4 6.5 8 10.5 12 6.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Minimize
    </button>
  )
}
