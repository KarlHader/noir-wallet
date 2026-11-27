import type { CSSProperties } from 'react'

/**
 * Heading text that types itself out, one character at a time behind a mint caret, when its
 * heading (marked data-reveal="type") comes into view; see useReveals and site.css. Only the
 * hero headline uses it. Screen readers get the plain text, and the characters are hidden from
 * them and from page translation.
 */
export function TypeIn({ text }: { text: string }) {
  const chars = [...text]
  const last = chars.length - 1

  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" translate="no">
        {chars.map((char, index) => (
          <span
            key={index}
            className={index === last ? 'tc tc-last' : 'tc'}
            style={{ '--c': index } as CSSProperties}
          >
            {char}
          </span>
        ))}
      </span>
    </>
  )
}
