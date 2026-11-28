import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

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

/** Elements of one section that arrive together follow one another, up to this many steps. */
const MAX_ORDER = 6

/**
 * Scroll reveals. Elements marked data-reveal start hidden and ease in the first time they come
 * into view: "up" fades in and rises, "type" types out a TypeIn heading. Elements of one section
 * that arrive together follow one another in page order (--order). An arrived element gets
 * data-in, an attribute React never sets, so re-renders cannot hide it again. With reduced
 * motion nothing is hidden at all.
 */
export function useReveals() {
  // Before the first paint, so nothing shows and then disappears
  useLayoutEffect(() => {
    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') return
    const root = document.documentElement

    const arrive = (items: HTMLElement[]) => {
      items.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      const queues = new Map<Element | null, number>()
      for (const item of items) {
        const section = item.closest('section, footer')
        const order = queues.get(section) ?? 0
        queues.set(section, order + 1)
        item.style.setProperty('--order', String(Math.min(order, MAX_ORDER)))
        item.setAttribute('data-in', '')
        observer.unobserve(item)
      }
    }

    const observer = new IntersectionObserver(
      entries =>
        arrive(
          entries.filter(entry => entry.isIntersecting).map(entry => entry.target as HTMLElement)
        ),
      // Things arrive once they are a little way onto the screen
      { rootMargin: '0px 0px -6% 0px' }
    )

    // At the very end of the page nothing can come further up, so whatever is left on screen
    // arrives (the footer's last lines would otherwise wait below the line forever)
    const atEnd = () => {
      if (window.innerHeight + window.scrollY < root.scrollHeight - 2) return
      arrive(
        [...document.querySelectorAll<HTMLElement>('[data-reveal]:not([data-in])')].filter(
          item => item.getBoundingClientRect().top < window.innerHeight
        )
      )
    }

    root.classList.add('reveals')
    document.querySelectorAll('[data-reveal]').forEach(item => observer.observe(item))
    window.addEventListener('scroll', atEnd, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', atEnd)
      root.classList.remove('reveals')
    }
  }, [])
}

/**
 * Cards marked .spot light up around a mouse pointer: --mx and --my hold the pointer's position
 * in the card, and site.css draws the glow and the brighter edge there.
 */
export function useSpotlight() {
  useEffect(() => {
    if (!window.matchMedia('(hover: hover)').matches) return
    let frame = 0
    let last: PointerEvent | null = null
    const paint = () => {
      frame = 0
      const target = last?.target
      if (!last || !(target instanceof Element)) return
      const card = target.closest<HTMLElement>('.spot')
      if (!card) return
      const box = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${last.clientX - box.left}px`)
      card.style.setProperty('--my', `${last.clientY - box.top}px`)
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return
      last = event
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      document.removeEventListener('pointermove', onMove)
      window.cancelAnimationFrame(frame)
    }
  }, [])
}
