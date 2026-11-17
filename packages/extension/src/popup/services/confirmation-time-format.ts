export function formatIntentsConfirmationTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const minimumSeconds = Math.min(Math.ceil(seconds), 300)
  if (minimumSeconds < 60) return `~${minimumSeconds} sec–5 min`
  return formatConfirmationTime({ minimumSeconds, maximumSeconds: 300 })
}

export function formatConfirmationTime(
  estimate: { readonly minimumSeconds: number; readonly maximumSeconds: number } | null
): string {
  if (!estimate) return '—'
  const { minimumSeconds, maximumSeconds } = estimate
  if (
    !Number.isFinite(minimumSeconds) ||
    !Number.isFinite(maximumSeconds) ||
    minimumSeconds <= 0 ||
    maximumSeconds < minimumSeconds
  )
    return '—'
  if (maximumSeconds < 1) return '<1 sec'
  const divisor = maximumSeconds < 60 ? 1 : 60
  const minimum = Math.max(1, Math.ceil(minimumSeconds / divisor))
  const maximum = Math.max(minimum, Math.ceil(maximumSeconds / divisor))
  return `~${minimum === maximum ? minimum : `${minimum}–${maximum}`} ${divisor === 1 ? 'sec' : 'min'}`
}
