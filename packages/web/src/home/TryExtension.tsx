import { loadDemo } from './demoLoader'
import { Icon } from './Icon'

/**
 * Button that opens the "Try the extension" demo.
 * cta: the prominent button next to the primary button in the hero; ghost: the secondary
 * button at the end of the page.
 * Hovering or focusing it starts loading the demo chunk.
 */
export function TryExtension({
  onOpen,
  variant
}: {
  onOpen: () => void
  variant: 'cta' | 'ghost'
}) {
  const warm = () => void loadDemo()
  return (
    <button
      type="button"
      className={variant === 'cta' ? 'btn btn-try' : 'btn btn-ghost'}
      onClick={onOpen}
      onPointerEnter={warm}
      onFocus={warm}
    >
      <Icon name="pointer" />
      Try the extension
    </button>
  )
}
