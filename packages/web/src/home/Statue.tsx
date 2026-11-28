/**
 * The statue at the very bottom of the page. It shows the plain image first; when the user is
 * about to scroll here, the particle effect loads (as a separate chunk) and swaps in the same
 * image built from particles, which scatter when the mouse passes over and then settle back.
 * With reduced motion, without WebGL, or on error, the original image stays.
 */
import { useEffect, useRef, useState } from 'react'
import { SHOTS } from './content'
import { prefersReducedMotion } from './motion'

export function Statue() {
  const boxRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    const box = boxRef.current
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!box || !img || !canvas || prefersReducedMotion()) return

    let stop: (() => void) | undefined
    let cancelled = false
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        near.disconnect()
        import('./particles')
          .then(({ createParticleImage }) => {
            if (cancelled) return
            stop = createParticleImage({
              box,
              img,
              canvas,
              hitArea: box.closest('footer') ?? box,
              onReady: () => setLive(true),
              onFail: () => setLive(false)
            })
          })
          .catch(() => setLive(false))
      },
      { rootMargin: '600px 0px' }
    )
    near.observe(box)
    return () => {
      cancelled = true
      near.disconnect()
      stop?.()
    }
  }, [])

  const shot = SHOTS.statue
  return (
    <div ref={boxRef} className={`statue${live ? ' is-live' : ''}`}>
      <img
        ref={imgRef}
        src={shot.src}
        width={shot.width}
        height={shot.height}
        alt=""
        loading="lazy"
      />
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  )
}
