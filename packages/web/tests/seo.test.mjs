import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  CAMPAIGN,
  FEEDBACK_REWARDS,
  HOME,
  SEO_PAGES,
  SHARE_IMAGE,
  SITE_URL,
  headTags,
  htmlFile,
  pageHtml,
  pageUrl,
  robotsTxt,
  seoPageFor,
  sitemapXml
} from '../src/seo.ts'

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const LIVE = { origin: SITE_URL, repositoryUrl: 'https://github.com/NoirWallet/noir-wallet' }
const PREVIEW = { ...LIVE, origin: 'https://ea2928d.noir-wallet.pages.dev' }

const count = (text, part) => text.split(part).length - 1
const attribute = (html, selector) => {
  const match = html.match(new RegExp(`<meta ${selector} content="([^"]*)"`))
  return match?.[1]
}

test('each page has a short title and a description that fits in a search result', () => {
  for (const page of SEO_PAGES) {
    assert.ok(page.title.length <= 60, `${page.path} title: ${page.title.length} characters`)
    assert.ok(
      page.description.length >= 70 && page.description.length <= 160,
      `${page.path} description: ${page.description.length} characters`
    )
  }
  assert.equal(new Set(SEO_PAGES.map(page => page.path)).size, SEO_PAGES.length)
  assert.equal(new Set(SEO_PAGES.map(page => page.title)).size, SEO_PAGES.length)
})

// Cloudflare Pages serves campaign.html at /campaign
test('each page is written to the file served at its path', () => {
  assert.deepEqual(SEO_PAGES.map(htmlFile), [
    'index.html',
    'campaign.html',
    'feedback-rewards.html'
  ])
})

test('each page gets its own head and no-JavaScript content from index.html', () => {
  for (const page of SEO_PAGES) {
    const html = pageHtml(template, page, LIVE)
    assert.doesNotMatch(html, /seo-(head|body)/)
    assert.equal(count(html, '<title>'), 1)
    assert.equal(count(html, 'name="description"'), 1)
    assert.equal(count(html, 'rel="canonical"'), 1)
    assert.ok(html.includes(`<link rel="canonical" href="${pageUrl(page)}" />`))
    assert.equal(attribute(html, 'property="og:url"'), pageUrl(page))
    assert.equal(attribute(html, 'name="twitter:card"'), 'summary_large_image')
    assert.equal(attribute(html, 'name="twitter:site"'), '@noir_wallet')
    assert.match(html, /<noscript>[\s\S]*<h1[^>]*>[^<]+<\/h1>[\s\S]*<\/noscript>/)
    // The head stays before the app's scripts, and the fallback inside the body
    assert.ok(html.indexOf('<title>') < html.indexOf('</head>'))
    assert.ok(html.indexOf('<noscript>') > html.indexOf('<body>'))
  }
  assert.equal(pageUrl(HOME), 'https://www.zknoir.com/')
  assert.equal(pageUrl(CAMPAIGN), 'https://www.zknoir.com/campaign')
})

test('titles and descriptions are escaped for HTML', () => {
  const html = pageHtml(template, CAMPAIGN, LIVE)
  assert.ok(html.includes('<title>Shield &amp; Win · Noir Wallet</title>'))
  assert.equal(attribute(html, 'property="og:title"'), 'Shield &amp; Win · Noir Wallet')
})

test('previews show their own share card but point search engines at the live site', () => {
  const html = pageHtml(template, CAMPAIGN, PREVIEW)
  assert.equal(attribute(html, 'property="og:image"'), `${PREVIEW.origin}${SHARE_IMAGE.path}`)
  assert.equal(attribute(html, 'name="twitter:image"'), `${PREVIEW.origin}${SHARE_IMAGE.path}`)
  assert.equal(attribute(html, 'property="og:url"'), 'https://www.zknoir.com/campaign')
  const live = pageHtml(template, CAMPAIGN, LIVE)
  assert.equal(
    attribute(live, 'property="og:image"'),
    'https://www.zknoir.com/images/share/noir-wallet.jpg'
  )
})

test('only the home page describes the wallet as structured data, with no made-up ratings', () => {
  for (const page of [CAMPAIGN, FEEDBACK_REWARDS]) {
    assert.doesNotMatch(headTags(page, LIVE), /ld\+json/)
  }
  const json = headTags(HOME, LIVE).match(
    /<script type="application\/ld\+json">(.*)<\/script>/
  )?.[1]
  assert.ok(json)
  const data = JSON.parse(json)
  assert.deepEqual(
    data['@graph'].map(node => node['@type']),
    ['Organization', 'WebSite', 'SoftwareApplication']
  )
  assert.ok(data['@graph'][0].sameAs.includes(LIVE.repositoryUrl))
  assert.doesNotMatch(json, /aggregateRating|review/i)
})

test('a template without exactly one of each marker is refused', () => {
  assert.throws(() => pageHtml('<html><head></head><body></body></html>', HOME, LIVE), /seo-head/)
  const doubled = template.replace('<!-- seo-body', '<!-- seo-body --><!-- seo-body')
  assert.throws(() => pageHtml(doubled, HOME, LIVE), /seo-body.*has 2/)
})

test('the dev server picks the page by path and falls back to the home page', () => {
  assert.equal(seoPageFor('/'), HOME)
  assert.equal(seoPageFor('/campaign'), CAMPAIGN)
  assert.equal(seoPageFor('/campaign/?utm_source=x#prizes'), CAMPAIGN)
  assert.equal(seoPageFor('/feedback-rewards'), FEEDBACK_REWARDS)
  assert.equal(seoPageFor('/frost'), HOME)
})

test('the sitemap lists the open pages, and robots.txt points to it', () => {
  const sitemap = sitemapXml(SEO_PAGES)
  assert.ok(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]),
    ['https://www.zknoir.com/', 'https://www.zknoir.com/campaign']
  )
  assert.match(robotsTxt(), /^User-agent: \*$/m)
  assert.match(robotsTxt(), /^Sitemap: https:\/\/www\.zknoir\.com\/sitemap\.xml$/m)
})

test('the share card is a 1200 × 630 JPEG', () => {
  const image = readFileSync(new URL(`../public${SHARE_IMAGE.path}`, import.meta.url))
  assert.equal(image.readUInt16BE(0), 0xffd8)
  // Walk the JPEG segments to the frame header, which holds the size
  let offset = 2
  while (offset < image.length) {
    const marker = image.readUInt16BE(offset)
    if (marker >= 0xffc0 && marker <= 0xffc3) {
      assert.equal(image.readUInt16BE(offset + 5), SHARE_IMAGE.height)
      assert.equal(image.readUInt16BE(offset + 7), SHARE_IMAGE.width)
      return
    }
    offset += 2 + image.readUInt16BE(offset + 2)
  }
  assert.fail('no JPEG frame header')
})
