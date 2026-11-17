import { useEffect, useState, type UIEventHandler } from 'react'

const PAGE_SIZE = 40

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

export function useTokenSelectorWindow(filterKey: string, total: number) {
  const ready = useTokenSelectorReady()
  const [window, setWindow] = useState({ key: filterKey, count: PAGE_SIZE })
  const limit = window.key === filterKey ? window.count : PAGE_SIZE
  const onScroll: UIEventHandler<HTMLDivElement> = event => {
    const list = event.currentTarget
    if (limit < total && list.scrollHeight - list.scrollTop - list.clientHeight < 200) {
      setWindow({ key: filterKey, count: limit + PAGE_SIZE })
    }
  }
  return { ready, limit, onScroll }
}
