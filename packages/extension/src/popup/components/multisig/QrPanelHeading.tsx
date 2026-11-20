import type { ReactNode } from 'react'
import { RingProgress } from './RingProgress'

export interface QrPanelHeadingProps {
  counter: { current: number; total: number }
  /** Above the ring, for example the ceremony's "Step n of m". */
  ringLabel?: ReactNode
  /** Below the ring, for example the phone being paired. */
  ringCaption?: ReactNode
  title: string
}

/** Progress ring and step title shared by the QR show and scan panels. */
export function QrPanelHeading({ counter, ringLabel, ringCaption, title }: QrPanelHeadingProps) {
  return (
    <>
      <div className="flex flex-col items-center gap-3">
        {ringLabel}
        <RingProgress current={counter.current} total={counter.total} />
        {ringCaption}
      </div>
      <h2 className="mt-5 text-lg font-semibold">{title}</h2>
    </>
  )
}
