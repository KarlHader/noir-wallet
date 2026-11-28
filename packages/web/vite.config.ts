import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import {
  SEO_PAGES,
  SITE_URL,
  htmlFile,
  pageHtml,
  robotsTxt,
  seoPageFor,
  sitemapXml,
  type SeoBuild
} from './src/seo'

const repository = process.env.WALLET_REPOSITORY ?? 'NoirWallet/noir-wallet'

if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repository)) {
  throw new Error('WALLET_REPOSITORY must be a non-empty GitHub owner/repo')
}

const repositoryUrl = `https://github.com/${repository}`
const releasesUrl = `${repositoryUrl}/releases`

// Cloudflare Pages builds the live site from main; its other builds are previews, whose share
// cards load from the preview itself (CF_PAGES_URL). Canonical addresses stay on the live site.
const previewOrigin =
  process.env.CF_PAGES_BRANCH && process.env.CF_PAGES_BRANCH !== 'main'
    ? process.env.CF_PAGES_URL
    : undefined
const seoBuild: SeoBuild = { origin: previewOrigin || SITE_URL, repositoryUrl }

export default defineConfig({
  cacheDir: resolve(__dirname, '../../output/node_modules/.vite/web'),
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'wallet-entry-redirects',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: '_redirects',
          source: [
            `/github          ${repositoryUrl}  302`,
            `/github/         ${repositoryUrl}  302`,
            `/beta/versions   ${releasesUrl}  302`,
            `/beta/versions/  ${releasesUrl}  302`,
            `/beta            ${releasesUrl}  302`,
            `/beta/           ${releasesUrl}  302`,
            // The campaign page moved; App.tsx does the same in the browser (dev server)
            '/shield-and-win  /campaign  302',
            '/shield-and-win/ /campaign  302',
            '/*               /index.html  200',
            ''
          ].join('\n')
        })
      }
    },
    // Each page's own title, description, canonical address and share card (src/seo.ts). The dev
    // server fills them in per request.
    {
      name: 'seo-pages:serve',
      apply: 'serve',
      transformIndexHtml(html, context) {
        return pageHtml(html, seoPageFor(context.originalUrl ?? '/'), seoBuild)
      }
    },
    // The build writes one HTML file per page from the finished index.html, which Cloudflare Pages
    // serves at the page's path ahead of the /* fallback above; unknown paths get the home page's.
    {
      name: 'seo-pages:build',
      apply: 'build',
      enforce: 'post',
      generateBundle(_, bundle) {
        const index = bundle['index.html']
        if (index?.type !== 'asset' || typeof index.source !== 'string') {
          this.error('seo-pages: index.html is missing from the bundle')
        }
        const template = index.source
        for (const page of SEO_PAGES) {
          const html = pageHtml(template, page, seoBuild)
          if (htmlFile(page) === 'index.html') {
            index.source = html
          } else {
            this.emitFile({ type: 'asset', fileName: htmlFile(page), source: html })
          }
        }
        this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(SEO_PAGES) })
        this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt() })
      }
    }
  ],
  define: {
    __WALLET_REPOSITORY_URL__: JSON.stringify(repositoryUrl),
    __WALLET_RELEASES_URL__: JSON.stringify(releasesUrl)
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  },
  server: {
    port: 5001,
    strictPort: false,
    proxy: {
      '/api/frost-signups': 'http://127.0.0.1:8788'
    }
  }
})
