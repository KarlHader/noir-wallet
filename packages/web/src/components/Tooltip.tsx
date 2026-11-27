import {
  cloneElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import '../tailwind.css'

type TooltipSide = 'top' | 'bottom'

interface TooltipProps {
  readonly content: ReactNode
  readonly side?: TooltipSide
  readonly variant?: 'text' | 'plain'
  readonly className?: string
  readonly children: ReactElement<{ 'aria-describedby'?: string }>
}

export function Tooltip({
  content,
  side = 'top',
  variant = 'text',
  className,
  children
}: TooltipProps) {
  const tooltipId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (!anchor) return

    const place = () => {
      const rect = anchor.getBoundingClientRect()
      setPoint({
        left: rect.left + rect.width / 2,
        top: side === 'top' ? rect.top : rect.bottom
      })
    }

    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, side])

  const describedBy = [children.props['aria-describedby'], open ? tooltipId : null]
    .filter(value => value && value.length > 0)
    .join(' ')

  return (
    <span
      ref={anchorRef}
      className={className ? `inline-flex max-w-full ${className}` : 'inline-flex max-w-full'}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false)
        setPoint(null)
      }}
      onFocus={() => setOpen(true)}
      onBlur={() => {
        setOpen(false)
        setPoint(null)
      }}
    >
      {describedBy.length > 0
        ? cloneElement(children, { 'aria-describedby': describedBy })
        : children}
      {open && point
        ? createPortal(
            <span
              id={tooltipId}
              role="tooltip"
              className={
                variant === 'plain'
                  ? 'pointer-events-none fixed z-[80] data-[side=bottom]:translate-y-2.5 data-[side=bottom]:-translate-x-1/2 data-[side=top]:-translate-x-1/2 data-[side=top]:-translate-y-[calc(100%+10px)] [&_img]:block [&_img]:h-auto [&_img]:w-[min(280px,calc(100vw-24px))] [&_img]:[filter:drop-shadow(0_16px_32px_rgba(0,0,0,0.45))]'
                  : "pointer-events-none fixed z-[80] data-[side=bottom]:translate-y-2.5 data-[side=bottom]:-translate-x-1/2 data-[side=top]:-translate-x-1/2 data-[side=top]:-translate-y-[calc(100%+10px)] w-max max-w-[min(280px,calc(100vw-24px))] rounded-lg border border-[#3a3a3a] bg-[#1c1c1c] px-3 py-2 text-center font-['DM_Sans',system-ui,sans-serif] text-[13px] leading-[1.45] font-medium whitespace-normal text-white"
              }
              data-side={side}
              style={{ left: point.left, top: point.top }}
            >
              {content}
            </span>,
            document.body
          )
        : null}
    </span>
  )
}
