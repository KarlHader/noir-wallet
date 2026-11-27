/**
 * What search engines and link previews (X, Telegram, Discord, Slack...) read about each page:
 * its title, description, canonical address and share card. The build writes it into each page's
 * HTML (the seo-pages plugins in vite.config.ts), so it is there before any JavaScript runs, and
 * the pages set the same titles in the browser. It stays free of browser and Vite globals: the
 * Vite config and the tests import it too.
 */
import { WALLET_STORE_URL } from './home/walletStore'

/** The live site. Canonical addresses always point here, previews included. */
export const SITE_URL = 'https://www.zknoir.com'
export const SITE_NAME = 'Noir Wallet'
export const X_HANDLE = '@noir_wallet'
const X_URL = 'https://x.com/noir_wallet'
const TELEGRAM_URL = 'https://t.me/noirprivacy'
const DOCS_URL = 'https://docs.zknoir.com/'

/** The link-preview card, in public/ */
export const SHARE_IMAGE = {
  path: '/images/share/noir-wallet.jpg',
  type: 'image/jpeg',
  width: 1200,
  height: 630,
  alt: 'Noir Wallet, the privacy-first multichain wallet, beside its wallet screen'
} as const

export interface SeoPage {
  /** Where the page is served, without a trailing slash; the home page is '/' */
  path: string
  title: string
  description: string
  /** The page's main heading, which visitors and crawlers without JavaScript see */
  heading: string
  /** Listed in sitemap.xml; pages that are not open yet stay out */
  listed: boolean
}

export const HOME: SeoPage = {
  path: '/',
  title: 'Noir Wallet - The Privacy-First Multichain Wallet',
  description:
    'Noir Wallet is the privacy-first multichain wallet. Send funds and use DeFi without exposing your balance, positions, or on-chain identity.',
  heading: 'The Privacy-First Multichain Wallet',
  listed: true
}

export const CAMPAIGN: SeoPage = {
  path: '/campaign',
  // The page's own heading until the campaign loads; then it names the prize (ShieldAndWinPage)
  title: 'Shield & Win · Noir Wallet',
  description:
    'Shield funds with Noir Wallet to enter an instant prize draw, and see how many prizes are still up for grabs.',
  heading: 'Shield & Win',
  listed: true
}

export const FEEDBACK_REWARDS: SeoPage = {
  path: '/feedback-rewards',
  title: 'Community Feedback Rewards · Noir Wallet',
  description:
    'Use Noir Wallet and report the bugs and rough edges you find. Every valid report earns points, and each round’s top three win ZEC.',
  heading: 'Report What You Find. Earn ZEC.',
  // Nothing links here until the first round is scheduled (FIRST_ROUND_START)
  listed: false
}

export const SEO_PAGES: readonly SeoPage[] = [HOME, CAMPAIGN, FEEDBACK_REWARDS]

/** What a build needs to know about where it is served */
export interface SeoBuild {
  /** The address this build is served from; the share card loads from it */
  origin: string
  /** The wallet's source code, listed with the site's profiles in the structured data */
  repositoryUrl: string
}

export function pageUrl(page: SeoPage): string {
  return `${SITE_URL}${page.path === '/' ? '/' : page.path}`
}

/** The HTML file the build writes for a page. Cloudflare Pages serves campaign.html at /campaign. */
export function htmlFile(page: SeoPage): string {
  return page.path === '/' ? 'index.html' : `${page.path.slice(1)}.html`
}

/** The page a request is for, by its path; anything else gets the home page's HTML */
export function seoPageFor(url: string): SeoPage {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '') || '/'
  return SEO_PAGES.find(page => page.path === path) ?? HOME
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ENTITIES[char])
}

/** Who makes the wallet, the site, and the wallet itself, for search engines (home page only) */
function structuredData(build: SeoBuild) {
  const organization = `${SITE_URL}/#organization`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organization,
        name: SITE_NAME,
        url: `${SITE_URL}/`,
        logo: `${SITE_URL}/logo.png`,
        sameAs: [X_URL, TELEGRAM_URL, build.repositoryUrl]
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: SITE_NAME,
        url: `${SITE_URL}/`,
        publisher: { '@id': organization }
      },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        description: HOME.description,
        url: `${SITE_URL}/`,
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Chrome',
        downloadUrl: WALLET_STORE_URL,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@id': organization }
      }
    ]
  }
}

/** The head tags for a page: title, description, canonical address and share card */
export function headTags(page: SeoPage, build: SeoBuild): string {
  const url = pageUrl(page)
  const image = `${build.origin}${SHARE_IMAGE.path}`
  const meta = (key: 'name' | 'property', name: string, content: string | number) =>
    `<meta ${key}="${name}" content="${escapeHtml(String(content))}" />`

  const tags = [
    `<title>${escapeHtml(page.title)}</title>`,
    meta('name', 'description', page.description),
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    meta('name', 'robots', 'max-image-preview:large'),
    meta('name', 'theme-color', '#000000'),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:locale', 'en_US'),
    meta('property', 'og:url', url),
    meta('property', 'og:title', page.title),
    meta('property', 'og:description', page.description),
    meta('property', 'og:image', image),
    meta('property', 'og:image:type', SHARE_IMAGE.type),
    meta('property', 'og:image:width', SHARE_IMAGE.width),
    meta('property', 'og:image:height', SHARE_IMAGE.height),
    meta('property', 'og:image:alt', SHARE_IMAGE.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:site', X_HANDLE),
    meta('name', 'twitter:title', page.title),
    meta('name', 'twitter:description', page.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', SHARE_IMAGE.alt)
  ]
  if (page === HOME) {
    // "<" is escaped so the JSON can never close its script element
    const json = JSON.stringify(structuredData(build)).replace(/</g, '\\u003c')
    tags.push(`<script type="application/ld+json">${json}</script>`)
  }
  return tags.join('\n    ')
}

/** What visitors and crawlers without JavaScript see: the page's heading, summary and links */
export function noscriptHtml(page: SeoPage): string {
  const link = (href: string, label: string) => `<a href="${escapeHtml(href)}">${label}</a>`
  return [
    '<noscript>',
    '      <div style="max-width: 40em; margin: 12vh auto; padding: 0 20px; font: 16px/1.6 system-ui, sans-serif">',
    `        <h1 style="margin: 0 0 12px; font-size: 32px; line-height: 1.2">${escapeHtml(page.heading)}</h1>`,
    `        <p>${escapeHtml(page.description)}</p>`,
    `        <p>${[
      link(WALLET_STORE_URL, 'Get Noir Wallet for Chrome'),
      link(DOCS_URL, 'Docs'),
      link(X_URL, 'X'),
      link(TELEGRAM_URL, 'Telegram')
    ].join(' · ')}</p>`,
    '        <p>Turn on JavaScript to see the rest of this page.</p>',
    '      </div>',
    '    </noscript>'
  ].join('\n')
}

/** The comments in index.html that a page's head tags and no-JavaScript content replace */
const HEAD_MARK = /<!--\s*seo-head\b[\s\S]*?-->/g
const BODY_MARK = /<!--\s*seo-body\b[\s\S]*?-->/g

function fill(html: string, mark: RegExp, content: string): string {
  const found = html.match(mark)?.length ?? 0
  if (found !== 1) {
    throw new Error(`index.html needs one ${mark.source} comment, and has ${found}`)
  }
  return html.replace(mark, () => content)
}

/** A page's HTML: index.html with the page's head tags and no-JavaScript content filled in */
export function pageHtml(template: string, page: SeoPage, build: SeoBuild): string {
  return fill(fill(template, HEAD_MARK, headTags(page, build)), BODY_MARK, noscriptHtml(page))
}

export function sitemapXml(pages: readonly SeoPage[]): string {
  const urls = pages
    .filter(page => page.listed)
    .map(page => `  <url>\n    <loc>${escapeHtml(pageUrl(page))}</loc>\n  </url>`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    ''
  ].join('\n')
}

export function robotsTxt(): string {
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${SITE_URL}/sitemap.xml`, ''].join('\n')
}
