import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type UIEventHandler
} from 'react'

export const TOKEN_SELECTOR_ROW_HEIGHT = 55
const WINDOW_SIZE = 40
const OVERSCAN = 8

export function useTokenSelectorReady(active = true): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!active) {
      setReady(false)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // Let the dialog shell paint before preparing its directory.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setReady(true), 0)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [active])
  return active && ready
}

export function useTokenSelectorWindow(
  filterKey: string,
  total: number,
  isDisabled?: (index: number) => boolean
) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const focusFrame = useRef<number | null>(null)
  const [window, setWindow] = useState({ key: filterKey, start: 0 })
  const maxStart = Math.max(0, total - WINDOW_SIZE)
  const startIndex = window.key === filterKey ? Math.min(window.start, maxStart) : 0
  const endIndex = Math.min(total, startIndex + WINDOW_SIZE)

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setWindow(current =>
      current.key === filterKey && current.start === 0 ? current : { key: filterKey, start: 0 }
    )
  }, [filterKey])
  useEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    },
    []
  )

  const updateWindow = (scrollTop: number) => {
    const next = Math.min(
      Math.max(0, Math.floor(scrollTop / TOKEN_SELECTOR_ROW_HEIGHT) - OVERSCAN),
      maxStart
    )
    setWindow(current =>
      current.key === filterKey && current.start === next
        ? current
        : { key: filterKey, start: next }
    )
  }
  const onScroll: UIEventHandler<HTMLDivElement> = event => {
    updateWindow(event.currentTarget.scrollTop)
  }
  const onKeyDown: KeyboardEventHandler<HTMLDivElement> = event => {
    const source = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-token-index]')
    if (!source || !event.currentTarget.contains(source) || total === 0) return
    const current = Number(source.dataset.tokenIndex)
    const page = Math.max(
      1,
      Math.floor(event.currentTarget.clientHeight / TOKEN_SELECTOR_ROW_HEIGHT)
    )
    let target: number
    let direction: number
    switch (event.key) {
      case 'ArrowDown':
        target = current + 1
        direction = 1
        break
      case 'ArrowUp':
        target = current - 1
        direction = -1
        break
      case 'PageDown':
        target = current + page
        direction = 1
        break
      case 'PageUp':
        target = current - page
        direction = -1
        break
      case 'Home':
        target = 0
        direction = 1
        break
      case 'End':
        target = total - 1
        direction = -1
        break
      case 'Tab':
        target = current + (event.shiftKey ? -1 : 1)
        direction = event.shiftKey ? -1 : 1
        break
      default:
        return
    }
    target = Math.max(0, Math.min(total - 1, target))
    while (target >= 0 && target < total && isDisabled?.(target)) target += direction
    if (target < 0 || target >= total || target === current) return
    if (event.key === 'Tab' && target >= startIndex && target < endIndex) return
    event.preventDefault()
    const list = event.currentTarget
    const rowTop = target * TOKEN_SELECTOR_ROW_HEIGHT
    if (rowTop < list.scrollTop) list.scrollTop = rowTop
    else if (rowTop + TOKEN_SELECTOR_ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = rowTop + TOKEN_SELECTOR_ROW_HEIGHT - list.clientHeight
    updateWindow(list.scrollTop)
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      list.querySelector<HTMLButtonElement>(`[data-token-index="${target}"]`)?.focus()
      focusFrame.current = null
    })
  }

  return {
    startIndex,
    endIndex,
    total,
    rowHeight: TOKEN_SELECTOR_ROW_HEIGHT,
    scrollRef,
    onScroll,
    onKeyDown
  }
}
