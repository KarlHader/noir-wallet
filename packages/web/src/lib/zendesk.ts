// Same Zendesk Messaging account as the Noir dashboard.
export const ZENDESK_SNIPPET_SRC =
  'https://static.zdassets.com/ekr/snippet.js?key=5531fb3e-bf22-4e06-87fe-14fa6b318c3f'

// Above the home page sticky header (z-index 50). The dashboard uses 45 so its own overlays stay on top.
export const ZENDESK_Z_INDEX = 60

export type ZendeskApi = (...args: unknown[]) => void | (() => void)

declare global {
  interface Window {
    zE?: ZendeskApi
    zESettings?: ZendeskSettings
  }
}

export interface ZendeskSettings {
  webWidget: {
    zIndex: number
    offset: {
      horizontal: string
      vertical: string
      mobile: { horizontal: string; vertical: string }
    }
  }
}

interface ZendeskScript {
  id: string
  async: boolean
  src: string
}

export interface ZendeskHost {
  zESettings?: ZendeskSettings
  document: {
    getElementById(id: string): unknown
    createElement(tag: 'script'): ZendeskScript
    body: { appendChild(node: ZendeskScript): void }
  }
}

interface LaunchState {
  lastAutoOpenedHref: string | null
}

export interface ZendeskSession {
  connect(): boolean
  navigate(): void
  dispose(): void
}

export function zendeskWidgetSettings(): ZendeskSettings {
  return {
    webWidget: {
      zIndex: ZENDESK_Z_INDEX,
      offset: {
        horizontal: '16px',
        vertical: '16px',
        // The dashboard lifts the launcher above its mobile tab bar. This site has no tab bar.
        mobile: { horizontal: '16px', vertical: '16px' }
      }
    }
  }
}

// Messaging ignores these legacy widget settings, but the snippet still reads them if it falls back.
export function installZendeskSnippet(host?: ZendeskHost): void {
  const target = host ?? (window as unknown as ZendeskHost)
  target.zESettings = zendeskWidgetSettings()
  if (target.document.getElementById('ze-snippet')) return
  const script = target.document.createElement('script')
  script.id = 'ze-snippet'
  script.async = true
  script.src = ZENDESK_SNIPPET_SRC
  target.document.body.appendChild(script)
}

// `?zendesk=1` opens the chat once per URL. Other visits clear that request.
// The first connection closes the widget when the page did not ask for it.
export function zendeskLaunchCommand(
  href: string,
  state: LaunchState,
  initial: boolean
): { command: 'open' | 'close' | null; state: LaunchState } {
  let requested = false
  try {
    requested = new URL(href).searchParams.get('zendesk') === '1'
  } catch {
    requested = false
  }
  if (!requested) {
    return { command: initial ? 'close' : null, state: { lastAutoOpenedHref: null } }
  }
  if (state.lastAutoOpenedHref === href) {
    return { command: null, state }
  }
  return { command: 'open', state: { lastAutoOpenedHref: href } }
}

export function createZendeskSession(options: {
  getApi: () => ZendeskApi | undefined
  getHref: () => string
  onOpenChange: (open: boolean) => void
}): ZendeskSession {
  let state: LaunchState = { lastAutoOpenedHref: null }
  let subscribed = false
  let active = true
  const unsubscribe: Array<() => void> = []

  function apply(initial: boolean) {
    const next = zendeskLaunchCommand(options.getHref(), state, initial)
    state = next.state
    if (next.command) options.getApi()?.('messenger', next.command)
  }

  return {
    connect() {
      const zE = options.getApi()
      if (!zE || subscribed) return subscribed
      subscribed = true
      zE('messenger:set', 'zIndex', ZENDESK_Z_INDEX)
      for (const [event, open] of [
        ['open', true],
        ['close', false]
      ] as const) {
        const cleanup = zE('messenger:on', event, () => {
          if (!active) return
          options.onOpenChange(open)
        })
        if (typeof cleanup === 'function') unsubscribe.push(cleanup)
      }
      apply(true)
      return true
    },
    navigate() {
      if (subscribed) apply(false)
    },
    dispose() {
      active = false
      for (const cleanup of unsubscribe) cleanup()
    }
  }
}
