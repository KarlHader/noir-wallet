import { useEffect, useState, type RefObject } from 'react'

export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Whether the element is in the viewport. With once set, it stays true after the first entry. */
export function useInView(ref: RefObject<Element | null>, threshold = 0.2, once = false) {
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting)
        if (once && entry.isIntersecting) observer.disconnect()
      },
      { threshold }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, threshold, once])

  return inView
}
