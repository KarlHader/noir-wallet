export function FeeSkeleton() {
  return (
    <span role="status" aria-label="Calculating network fee" className="inline-flex items-center">
      <span
        aria-hidden="true"
        className="inline-block h-4 w-24 animate-pulse rounded bg-white/10"
      />
    </span>
  )
}
