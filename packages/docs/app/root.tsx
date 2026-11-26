import type { LinksFunction } from 'react-router'
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'
import { RootProvider } from 'fumadocs-ui/provider/react-router'
import { SearchDialog } from '@/components/search'
import styles from '@/styles.css?url'
import noirWalletLogo from '../../extension/public/icons/icon128.png?url'

// Same typefaces as the zknoir.com home page: DM Sans for text, Doto for small labels.
const fonts =
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Doto:wght@400&display=swap'

export const links: LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  { rel: 'stylesheet', href: fonts },
  { rel: 'stylesheet', href: styles },
  { rel: 'icon', type: 'image/png', href: noirWalletLogo }
]

export default function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#000000" />
        <Meta />
        <Links />
      </head>
      <body>
        <RootProvider
          search={{ SearchDialog }}
          theme={{ forcedTheme: 'dark', defaultTheme: 'dark', enableSystem: false }}
        >
          <Outlet />
        </RootProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}
