import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

const repository = process.env.WALLET_REPOSITORY ?? 'NoirWallet/noir-wallet'

if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repository)) {
  throw new Error('WALLET_REPOSITORY must be a non-empty GitHub owner/repo')
}

const repositoryUrl = `https://github.com/${repository}`
const releasesUrl = `${repositoryUrl}/releases`

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
            '/*               /index.html  200',
            ''
          ].join('\n')
        })
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
