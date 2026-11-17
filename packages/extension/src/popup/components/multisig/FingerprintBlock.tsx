interface FingerprintBlockProps {
  value: string
}

// Longer values (a 10-group identity) wrap at a fixed point so both devices show the same rows.
const GROUPS_PER_ROW = 5
const SINGLE_ROW_MAX_GROUPS = 6

function fingerprintRows(value: string): string[] {
  const groups = value.split(' ').filter(Boolean)
  if (groups.length <= SINGLE_ROW_MAX_GROUPS) return [groups.join(' ')]
  const rows: string[] = []
  for (let start = 0; start < groups.length; start += GROUPS_PER_ROW) {
    rows.push(groups.slice(start, start + GROUPS_PER_ROW).join(' '))
  }
  return rows
}

/** Large monospace block for comparing a fingerprint across devices by eye. */
export function FingerprintBlock({ value }: FingerprintBlockProps) {
  return (
    <div className="rounded-xl bg-card px-4 py-5 text-center font-mono text-lg tracking-wide break-words">
      {fingerprintRows(value).map((row, index) => (
        <div key={index}>{row}</div>
      ))}
    </div>
  )
}
