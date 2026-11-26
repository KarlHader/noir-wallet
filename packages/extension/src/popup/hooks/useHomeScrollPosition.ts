import { useLayoutEffect, useRef } from 'react'

const positions = new Map<string, number>()

export function useHomeScrollPosition(entryKey: string, scope: string) {
  const region = useRef<HTMLDivElement>(null)
  const nextPosition = useRef<number | null>(null)
  useLayoutEffect(() => {
    const element = region.current
    if (!element) return
    const key = JSON.stringify([entryKey, scope])
    const saved = nextPosition.current ?? positions.get(key) ?? 0
    nextPosition.current = null
    let restoring = saved > 0
    const restore = () => {
      if (!restoring) return
      element.scrollTop = saved
      if (element.scrollTop >= saved - 1) restoring = false
    }
    const remember = () => {
      if (restoring) return
      positions.set(key, element.scrollTop)
      if (positions.size > 40) positions.delete(positions.keys().next().value!)
    }
    const interrupt = () => {
      restoring = false
    }
    element.scrollTop = saved
    restore()
    const observer = new MutationObserver(restore)
    if (restoring) observer.observe(element, { childList: true, subtree: true, attributes: true })
    element.addEventListener('scroll', remember, { passive: true })
    element.addEventListener('wheel', interrupt, { passive: true })
    element.addEventListener('touchstart', interrupt, { passive: true })
    element.addEventListener('keydown', interrupt)
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', remember)
      element.removeEventListener('wheel', interrupt)
      element.removeEventListener('touchstart', interrupt)
      element.removeEventListener('keydown', interrupt)
    }
  }, [entryKey, scope])
  return { region, nextPosition }
}
