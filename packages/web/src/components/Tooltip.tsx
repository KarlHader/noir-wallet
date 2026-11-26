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
import './tooltip.css'

type TooltipSide = 'top' | 'bottom'

interface TooltipProps {
  readonly content: ReactNode
  readonly side?: TooltipSide
  readonly variant?: 'text' | 'plain'
  readonly children: ReactElement<{ 'aria-describedby'?: string }>
}

export function Tooltip({ content, side = 'top', variant = 'text', children }: TooltipProps) {
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
      className="noir-tooltip-anchor"
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
                  ? 'noir-tooltip noir-tooltip-plain'
                  : 'noir-tooltip noir-tooltip-text'
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
