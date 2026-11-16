import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { extractChangelogVersion } from '../../../../../scripts/extract-changelog.mjs'

const changelog = `# Changelog

## [1.0.26] - 2026-07-19

### Added

- Current release

## [1.0.25] - 2026-07-13

### Fixed

- Previous release
`

describe('Production changelog extraction', () => {
  it('extracts only the requested release body', () => {
    assert.equal(extractChangelogVersion(changelog, '1.0.26'), '### Added\n\n- Current release')
  })

  it('supports the final release section', () => {
    assert.equal(extractChangelogVersion(changelog, '1.0.25'), '### Fixed\n\n- Previous release')
  })

  it('rejects a missing release section', () => {
    assert.throws(
      () => extractChangelogVersion(changelog, '1.0.27'),
      /Expected exactly one changelog section for 1\.0\.27, found 0/
    )
  })

  it('rejects duplicate release sections', () => {
    assert.throws(
      () => extractChangelogVersion(`${changelog}\n## [1.0.26]\n\n- Duplicate`, '1.0.26'),
      /Expected exactly one changelog section for 1\.0\.26, found 2/
    )
  })
})
