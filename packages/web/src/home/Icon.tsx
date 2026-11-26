import type { ReactNode } from 'react'

/** The few line icons used on the site; the strokes match the wallet's. */
const PATHS = {
  send: <path d="M7 17 17 7M9 7h8v8" />,
  receive: <path d="M17 7 7 17M15 17H7V9" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  external: <path d="M8 16 16 8M9.5 8H16v6.5" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  // Lucide mouse-pointer-click: "click to try"
  pointer: (
    <>
      <path d="M14 4.1 12 6M5.1 8l-2.9-.8M6 12l-1.9 2M7.2 2.2 8 5.1" />
      <path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z" />
    </>
  )
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
