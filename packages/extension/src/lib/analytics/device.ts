export interface AnalyticsDeviceMetadata {
  browser: string
  browser_major_version?: string
  device_category: 'desktop'
  language: string
  operating_system: string
}

function detectBrowser(userAgent: string): { name: string; major?: string } {
  for (const [name, marker] of [
    ['Edge', 'Edg'],
    ['Opera', 'OPR'],
    ['Firefox', 'Firefox'],
    ['Chrome', 'Chrome'],
    ['Safari', 'Version']
  ]) {
    const match = userAgent.match(new RegExp(`(?:^|\\s)${marker}/(\\d{1,3})(?:\\.|\\s|$)`))
    if (match) return { name, major: match[1] }
  }
  return { name: 'Other' }
}

function detectOperatingSystem(userAgent: string): string {
  if (/CrOS\b/.test(userAgent)) return 'Chrome OS'
  if (/Windows\b/.test(userAgent)) return 'Windows'
  if (/Android\b/.test(userAgent)) return 'Android'
  if (/(?:iPhone|iPad|iPod)\b/.test(userAgent)) return 'iOS'
  if (/(?:Macintosh|Mac OS X)\b/.test(userAgent)) return 'macOS'
  if (/Linux\b/.test(userAgent)) return 'Linux'
  return 'Other'
}

function normalizeLanguage(language: string): string {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) return 'und'
  try {
    return Intl.getCanonicalLocales(language)[0] ?? 'und'
  } catch {
    return 'und'
  }
}

/** Returns deliberately coarse device data suitable for both analytics channels. */
export function getAnalyticsDeviceMetadata(
  source: Pick<Navigator, 'language' | 'userAgent'> = navigator
): AnalyticsDeviceMetadata {
  const browser = detectBrowser(source.userAgent)
  return {
    browser: browser.name,
    ...(browser.major ? { browser_major_version: browser.major } : {}),
    device_category: 'desktop',
    language: normalizeLanguage(source.language),
    operating_system: detectOperatingSystem(source.userAgent)
  }
}
