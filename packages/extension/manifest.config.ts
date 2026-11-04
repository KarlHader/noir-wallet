import { defineManifest } from '@crxjs/vite-plugin'
import packageJson from './package.json'
import { DAPP_CONTENT_SCRIPT_MATCHES, EXTENSION_SIDE_PANEL_PATH } from './src/config/extension'
import { resolveDevelopmentExtensionKey } from './scripts/lib/extension-build-config'
import {
  ALL_CHAIN_FEATURE_FLAGS,
  EVM_CHAIN_FEATURE_FLAG,
  parseEnabledChainFeatureFlags
} from './src/config/multichain-feature-flags'

const { version, description } = packageJson

const extensionVersion = version.split('-')[0]
const isTestnet = process.env.NETWORK_MODE === 'testnet'
const developmentExtensionKey = resolveDevelopmentExtensionKey(process.env)
const earlyEvmProviderEnabled = parseEnabledChainFeatureFlags(
  process.env.ENABLED_CHAIN_FEATURE_FLAGS,
  ALL_CHAIN_FEATURE_FLAGS
).includes(EVM_CHAIN_FEATURE_FLAG)

export default defineManifest(async env => ({
  manifest_version: 3,
  ...(developmentExtensionKey ? { key: developmentExtensionKey } : {}),
  name: isTestnet
    ? '[Testnet] Noir Wallet'
    : env.mode === 'staging'
      ? '[Staging] Noir Wallet'
      : 'Noir Wallet',
  version: extensionVersion,
  ...(version !== extensionVersion ? { version_name: version } : {}),
  description,
  permissions: ['storage', 'offscreen', 'notifications', 'alarms', 'sidePanel', 'favicon'],
  host_permissions: ['https://*/*', 'http://localhost/*'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module'
  },
  action: {
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png'
    }
  },
  side_panel: {
    default_path: EXTENSION_SIDE_PANEL_PATH
  },
  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png'
  },
  content_scripts: [
    ...(earlyEvmProviderEnabled
      ? [
          {
            matches: [...DAPP_CONTENT_SCRIPT_MATCHES],
            js: ['public/early-evm-provider.js'],
            run_at: 'document_start' as const,
            world: 'MAIN' as const
          }
        ]
      : []),
    {
      matches: [...DAPP_CONTENT_SCRIPT_MATCHES],
      js: ['src/content-script/index.ts'],
      run_at: 'document_start'
    },
    {
      matches: [...DAPP_CONTENT_SCRIPT_MATCHES],
      js: ['src/content-script/inject-provider.ts'],
      run_at: 'document_start',
      world: 'MAIN'
    }
  ],
  web_accessible_resources: [
    {
      resources: ['assets/*.js', 'assets/*.css'],
      matches: [...DAPP_CONTENT_SCRIPT_MATCHES]
    }
  ],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*;"
  },
  cross_origin_embedder_policy: {
    value: 'credentialless'
  },
  cross_origin_opener_policy: {
    value: 'same-origin'
  }
}))
