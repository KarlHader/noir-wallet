import type { CSSProperties } from 'react'

/**
 * Heading text that types itself out, one character at a time behind a mint caret, when its
 * heading (marked data-reveal="type") comes into view; see useReveals and site.css. Only the
 * hero headline uses it. The text is in the page once, in a screen-reader span, so search engines
 * and screen readers read it as written; the typed characters are drawn by CSS from data-ch and
 * add no text of their own.
 */
export function TypeIn({ text }: { text: string }) {
  const chars = [...text]
  const last = chars.length - 1

  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {chars.map((char, index) => (
          <span
            key={index}
            className={index === last ? 'tc tc-last' : 'tc'}
            data-ch={char}
            style={{ '--c': index } as CSSProperties}
          />
        ))}
      </span>
    </>
  )
}
