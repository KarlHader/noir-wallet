import { Icon } from './Icon'

/**
 * The mobile and desktop apps, which are not out yet: two greyed-out buttons beside Install,
 * each tagged Soon like the upcoming privacy providers.
 */
export function AppsComingSoon() {
  return (
    <>
      <button type="button" className="btn btn-ghost btn-soon" disabled>
        <Icon name="mobile" />
        Mobile
        <em>Soon</em>
      </button>
      <button type="button" className="btn btn-ghost btn-soon" disabled>
        <Icon name="desktop" />
        Desktop
        <em>Soon</em>
      </button>
    </>
  )
}
