import type { ReactNode } from 'react'

/** The few line icons used on the site; the strokes match the wallet's. */
const PATHS = {
  send: <path d="M7 17 17 7M9 7h8v8" />,
  receive: <path d="M17 7 7 17M15 17H7V9" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  external: <path d="M8 16 16 8M9.5 8H16v6.5" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="M5 12.5 9.5 17 19 7.5" />,
  // Lucide message-circle: the support chat
  chat: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  // Lucide triangle-alert
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  // Lucide shield
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  // Lucide copy
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  // Lucide mouse-pointer-click: "click to try"
  pointer: (
    <>
      <path d="M14 4.1 12 6M5.1 8l-2.9-.8M6 12l-1.9 2M7.2 2.2 8 5.1" />
      <path d="M9.04 9.69a.5.5 0 0 1 .65-.65l11 4.5a.5.5 0 0 1-.07.95l-4.35 1.04a1 1 0 0 0-.74.74l-1.04 4.35a.5.5 0 0 1-.95.07z" />
    </>
  )
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

/**
 * Filled brand marks for the footer, at the design mock's sizes. X and GitHub are the paths
 * exported from the mock; the Telegram plane is drawn to match it, with the fold left as a gap.
 */
const SOCIAL = {
  x: {
    box: '0 0 16 16',
    body: (
      <path d="M9.52373 6.77569L15.4811 0H14.0699L8.89493 5.88203L4.7648 0H0L6.24693 8.89552L0 16H1.4112L6.87253 9.78704L11.2352 16H16M1.92053 1.04127H4.08853L14.0688 15.0099H11.9003" />
    )
  },
  telegram: {
    box: '0 0 19 16',
    body: <path d="M0 7.2 18.7 0.2 7.5 9.4ZM8.7 10 19 0.7 10.6 15.7Z" />
  },
  github: {
    box: '0 0 18 18',
    body: (
      <path d="M8.99922 0C4.02965 0 0 4.1306 0 9.22725C0 13.3049 2.57791 16.7631 6.15522 17.9843C6.60443 18.067 6.74687 17.795 6.74687 17.5502C6.74687 17.3304 6.75156 16.7182 6.74687 15.9479C4.24409 16.5048 3.72522 14.7323 3.72522 14.7323C3.31591 13.666 2.72739 13.3827 2.72739 13.3827C1.90957 12.8098 2.78765 12.8219 2.78765 12.8219C3.69 12.8861 4.16661 13.7719 4.16661 13.7719C4.96956 15.1824 6.27261 14.7748 6.78522 14.5389C6.86817 13.9436 7.09983 13.5352 7.3573 13.3065C5.35852 13.0722 3.258 12.2819 3.258 8.74423C3.258 7.73725 3.60861 6.91402 4.18461 6.26811C4.09226 6.03623 3.78235 5.09665 4.27226 3.8265C4.27226 3.8265 5.02904 3.57857 6.74687 4.7733C7.48146 4.56789 8.23936 4.46321 9.00078 4.46198C9.76461 4.46599 10.5347 4.56789 11.2547 4.7733C12.9725 3.57937 13.727 3.8265 13.727 3.8265C14.2177 5.09665 13.9085 6.03623 13.8162 6.26811C14.3922 6.91402 14.742 7.73725 14.742 8.74423C14.742 12.2907 12.6376 13.0698 10.6325 13.2969C10.955 13.5833 11.2484 14.137 11.2484 14.9979V17.5526C11.2484 17.7998 11.394 18.0718 11.851 17.9827C15.4244 16.7607 18 13.3033 18 9.22725C18 4.1306 13.9711 0 8.99922 0Z" />
    )
  }
} satisfies Record<string, { box: string; body: ReactNode }>

export function SocialIcon({ name }: { name: keyof typeof SOCIAL }) {
  const [, , w, h] = SOCIAL[name].box.split(' ')
  return (
    <svg viewBox={SOCIAL[name].box} width={w} height={h} fill="currentColor" aria-hidden="true">
      {SOCIAL[name].body}
    </svg>
  )
}

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
