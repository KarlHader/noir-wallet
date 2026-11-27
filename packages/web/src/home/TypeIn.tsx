import type { CSSProperties } from 'react'

/**
 * Heading text that types itself out, one character at a time behind a mint caret, when its
 * heading (marked data-reveal="type") comes into view; see useReveals and site.css. Screen
 * readers get the plain text, and the characters are hidden from them and from page
 * translation. A line break in the text becomes a <br>.
 */
export function TypeIn({ text }: { text: string }) {
  let count = 0
  const chars = [...text].map(char => (char === '\n' ? null : { char, index: count++ }))

  return (
    <>
      <span className="sr-only">{text.replace(/\n/g, ' ')}</span>
      <span aria-hidden="true" translate="no">
        {chars.map((item, key) =>
          item === null ? (
            <br key={key} />
          ) : (
            <span
              key={key}
              className={item.index === count - 1 ? 'tc tc-last' : 'tc'}
              style={{ '--c': item.index } as CSSProperties}
            >
              {item.char}
            </span>
          )
        )}
      </span>
    </>
  )
}
