import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const extensionDirectory = fileURLToPath(new URL('..', import.meta.url))
const allChains = 'chain.evm,chain.bitcoin,chain.solana,chain.near'
const testReleaseEnvironment = {
  EVM_HISTORY_API_ORIGIN: 'https://evm-history.test',
  RHEA_SWAP_ACCESS_TOKEN: 'test-rhea-access-token',
  GA_API_SECRET: 'test-analytics-api-secret',
  CUSTOM_ANALYTICS_PASSWORD: 'test-analytics-password'
}

function isolated(profile, features, options = {}) {
  return {
    profile,
    network: profile.startsWith('testnet-') ? 'testnet' : 'mainnet',
    features,
    build: true,
    workers: 1,
    ...options
  }
}

const projects = {
  extension: isolated('mainnet-zcash-regression', '', { workers: 4 }),
  'release-default': isolated('mainnet-release-default', undefined, {
    prepareExample: true,
    env: { ...testReleaseEnvironment, BUILD_CHANNEL: 'beta', E2E_SCREENSHOTS: '1' }
  }),
  'production-dist': {
    build: true,
    workers: 1,
    env: { ...testReleaseEnvironment, BUILD_CHANNEL: 'production', E2E_SCREENSHOTS: '1' }
  },
  'development-extension': { env: { DEV_EXTENSION_E2E: '1' } },
  'transaction-testnet': isolated('testnet-transactions', ''),
  'evm-testnet': isolated('testnet-evm', 'chain.evm', {
    env: { APPROVAL_WINDOW_E2E: '1' }
  }),
  'multichain-receive-testnet': isolated('testnet-multichain-receive', allChains),
  'solana-near-portfolio-testnet': isolated(
    'testnet-solana-near-portfolio',
    'chain.solana,chain.near'
  ),
  'private-key-testnet': isolated('testnet-private-key', allChains),
  'bitcoin-testnet': isolated('testnet-bitcoin', 'chain.bitcoin', {
    env: { APPROVAL_WINDOW_E2E: '1' }
  }),
  'protocol-mainnet': isolated('mainnet-protocol', 'chain.evm,chain.bitcoin', {
    env: {
      RHEA_SWAP_ACCESS_TOKEN: 'test-rhea-access-token',
      APPROVAL_WINDOW_E2E: '1',
      E2E_SCREENSHOTS: '1'
    }
  }),
  'live-services': { live: true, workers: 1 },
  'asset-price-live': isolated('mainnet-asset-price-live', 'chain.evm', { live: true }),
  'funding-source-live': isolated('testnet-transactions', '', { live: true }),
  'evm-testnet-live': isolated('testnet-evm', 'chain.evm', { live: true }),
  'solana-near-testnet-live': isolated('testnet-solana-near-live', 'chain.solana,chain.near', {
    live: true,
    env: { APPROVAL_WINDOW_E2E: '1' }
  }),
  'bitcoin-testnet-live': isolated('testnet-bitcoin', 'chain.bitcoin', {
    live: true,
    env: { APPROVAL_WINDOW_E2E: '1' }
  }),
  'protocol-live': isolated('mainnet-protocol', 'chain.evm,chain.bitcoin', { live: true })
}

const rcProjects = [
  'extension',
  'release-default',
  'transaction-testnet',
  'multichain-receive-testnet',
  'private-key-testnet',
  'evm-testnet',
  'bitcoin-testnet',
  'protocol-mainnet'
]

function help() {
  console.log(`Usage: pnpm test [core|e2e|live|rc|screenshots] [project] [options]

  pnpm test                           Offline core tests (Node options accepted)
  pnpm test --list                    List core test files
  pnpm test e2e <project>             Build and run one MV3 project
  pnpm test live [project]            Run live-services by default; other projects are explicit
  pnpm test rc                        Run the existing multichain RC sequence
  pnpm test screenshots [--prune]     Check the screenshot catalog

Use --dry-run to print commands without executing them.
Use --skip-build with e2e/live to reuse a matching build; other options go to Playwright.
development-extension requires pnpm dev:extension to be running.
Live projects retain their existing credential and broadcast opt-in requirements.

E2E projects: ${Object.entries(projects)
    .filter(([, config]) => !config.live)
    .map(([name]) => name)
    .join(', ')}
Live projects: ${Object.entries(projects)
    .filter(([, config]) => config.live)
    .map(([name]) => name)
    .join(', ')}`)
}

const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
if (args.includes('--help') || args.includes('-h')) {
  help()
  process.exit(0)
}
const mode = args[0] && !args[0].startsWith('-') ? args.shift() : 'core'
const dryRun = removeFlag('--dry-run')
const skipBuild = removeFlag('--skip-build')

function removeFlag(flag) {
  const index = args.indexOf(flag)
  if (index < 0) return false
  args.splice(index, 1)
  return true
}

function run(command, commandArgs, env = process.env) {
  const label =
    env.E2E_BUILD_PROFILE ??
    `${env.NETWORK_MODE ?? 'mainnet'}-${env.BUILD_CHANNEL ?? 'development'}`
  console.log(
    `\n[${label}] ${command === process.execPath ? 'node' : command} ${commandArgs.join(' ')}`
  )
  if (dryRun) return
  const result = spawnSync(command, commandArgs, {
    cwd: extensionDirectory,
    env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function projectEnvironment(config) {
  return {
    ...process.env,
    BUILD_CHANNEL: 'development',
    NETWORK_MODE: config.network ?? 'mainnet',
    PLAYWRIGHT_E2E: config.profile ? '1' : undefined,
    E2E_BUILD_PROFILE: config.profile,
    ENABLED_CHAIN_FEATURE_FLAGS: config.features,
    BETA_INVITE_REQUIRED: undefined,
    EXTENSION_DEV_SERVER: undefined,
    ...config.env
  }
}

function runProject(name, extraArgs = [], overrides = {}) {
  const config = projects[name]
  const env = { ...projectEnvironment(config), ...overrides }
  if (!skipBuild && config.prepareExample) {
    run('pnpm', ['--filter', '@noir-wallet/sdk', 'build'], env)
    run('pnpm', ['--filter', '@noir-wallet/example', 'build'], env)
  }
  if (!skipBuild && config.build) run('pnpm', ['run', 'build'], env)
  run(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      `--project=${name}`,
      ...(config.workers ? [`--workers=${config.workers}`] : []),
      ...extraArgs
    ],
    env
  )
}

function runCore(coreArgs = []) {
  run(process.execPath, [
    fileURLToPath(new URL('../../../scripts/run-core-tests.mjs', import.meta.url)),
    ...coreArgs
  ])
}

function runScreenshots(screenshotArgs = []) {
  run(process.execPath, ['scripts/check-e2e-screenshots.mjs', ...screenshotArgs])
}

try {
  if (skipBuild && mode !== 'e2e' && mode !== 'live') {
    throw new Error('--skip-build is only supported for e2e/live')
  }
  switch (mode) {
    case 'core':
      runCore(args)
      break
    case 'e2e':
    case 'live': {
      const name =
        args[0] && !args[0].startsWith('-')
          ? args.shift()
          : mode === 'live'
            ? 'live-services'
            : undefined
      if (!Object.hasOwn(projects, name) || Boolean(projects[name].live) !== (mode === 'live')) {
        throw new Error(`Choose a ${mode} project from pnpm test --help`)
      }
      if (args.some(argument => argument === '--project' || argument.startsWith('--project='))) {
        throw new Error('Choose the project after e2e/live instead of using --project')
      }
      runProject(name, args)
      break
    }
    case 'rc':
      if (args.length > 0) throw new Error('rc only accepts --dry-run')
      runCore()
      for (const name of rcProjects) runProject(name, [], { E2E_SCREENSHOTS: '1' })
      for (const network of ['mainnet', 'testnet']) {
        run('pnpm', ['run', 'build'], {
          ...projectEnvironment(projects['production-dist']),
          NETWORK_MODE: network
        })
      }
      runScreenshots()
      break
    case 'screenshots':
      if (args.some(argument => argument !== '--prune')) {
        throw new Error('screenshots only accepts --prune and --dry-run')
      }
      runScreenshots(args)
      break
    default:
      throw new Error(`Unknown test command: ${mode}. Run pnpm test --help`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
