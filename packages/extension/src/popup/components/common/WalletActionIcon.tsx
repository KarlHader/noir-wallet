export function WalletActionIcon({
  action,
  size = 20,
  className
}: {
  readonly action: 'send' | 'receive' | 'move' | 'swap'
  readonly size?: number
  readonly className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      className={className}
    >
      {action === 'send' && <path d="M4 4H16V16M16 4L4 16" stroke="currentColor" strokeWidth="2" />}
      {action === 'receive' && (
        <path d="M4 4V16H16M4 16L16 4" stroke="currentColor" strokeWidth="2" />
      )}
      {action === 'move' && (
        <path
          d="M18.999 12.715V15.271H7.232L9.978 18.467L8.015 20L2 12.715H18.999ZM18.999 8.158H2.001V5.729H13.769L11.023 2.533L12.984 1L18.999 8.158Z"
          fill="currentColor"
          transform="translate(-.5 -.5)"
        />
      )}
      {action === 'swap' && (
        <g stroke="currentColor" strokeWidth="2" transform="translate(1 1)">
          <path d="M7.5 2H2V7.5M10.5 16H16V10.5" />
          <circle cx="4.5" cy="13.5" r="3.5" />
          <circle cx="13.5" cy="4.5" r="3.5" />
        </g>
      )}
    </svg>
  )
}
