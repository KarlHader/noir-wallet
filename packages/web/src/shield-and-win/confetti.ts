/**
 * A short burst of confetti on a canvas, in the campaign's colours, fanning up from `origin`
 * (canvas CSS pixels) and falling away. Returns a function that stops it early. No library: the
 * site adds no dependencies for one effect.
 */
const COLORS = ['#3dffbe', '#00d18a', '#ffcc00', '#f0cb45', '#ffffff', '#9dffd9']
const PIECES = 90

export function confettiBurst(
  canvas: HTMLCanvasElement,
  origin: { x: number; y: number },
  durationMs = 1900
): () => void {
  const context = canvas.getContext('2d')
  if (!context) return () => undefined
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const { width, height } = canvas.getBoundingClientRect()
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  context.scale(ratio, ratio)

  const pieces = Array.from({ length: PIECES }, (_, index) => {
    // Upward, in a fan about 100 degrees wide
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.75
    const speed = 5 + Math.random() * 6
    return {
      x: origin.x,
      y: origin.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 4 + Math.random() * 4,
      h: 7 + Math.random() * 7,
      turn: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.32,
      color: COLORS[index % COLORS.length],
      round: Math.random() < 0.22
    }
  })

  let frame = 0
  const start = performance.now()
  const draw = (now: number) => {
    const elapsed = now - start
    context.clearRect(0, 0, width, height)
    context.globalAlpha = Math.max(
      0,
      1 - Math.max(0, elapsed - durationMs * 0.55) / (durationMs * 0.45)
    )
    for (const piece of pieces) {
      piece.vy += 0.2
      piece.vx *= 0.985
      piece.vy *= 0.985
      piece.x += piece.vx
      piece.y += piece.vy
      piece.turn += piece.spin
      context.save()
      context.translate(piece.x, piece.y)
      context.rotate(piece.turn)
      context.fillStyle = piece.color
      if (piece.round) {
        context.beginPath()
        context.arc(0, 0, piece.w / 2, 0, Math.PI * 2)
        context.fill()
      } else {
        context.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h)
      }
      context.restore()
    }
    if (elapsed < durationMs) frame = requestAnimationFrame(draw)
    else context.clearRect(0, 0, width, height)
  }
  frame = requestAnimationFrame(draw)
  return () => {
    cancelAnimationFrame(frame)
    context.clearRect(0, 0, width, height)
  }
}
