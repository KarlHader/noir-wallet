import type { Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  parseCredentialGenerationId,
  parseEngineCredentialRef,
  parseKeyDomainId
} from '../../src/core/keyring/domain'
import {
  authenticateSoftwareCredentialEnvelopePair,
  unwrapSoftwareCredentialEnvelopePair
} from '../../src/infrastructure/keyring/credential-envelope-authentication'
import {
  decodeV1EncryptedCredentialEnvelope,
  encodeV1EncryptedCredentialEnvelope
} from '../../src/infrastructure/keyring/migration/v1-credential-envelope'
import { parseRawEncryptedVault } from '../../src/infrastructure/keyring/multichain/raw-wallet-engine'
import { parseCredentialTransactionId } from '../../src/infrastructure/persistence/schema'
import {
  CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
  type EncryptedCredentialEnvelopeRecord
} from '../../src/ports/repositories'
import { expect, test, waitForBackgroundWalletInitialization } from '../helpers/extension-fixtures'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSWORD = 'resource-budget-password'
const MAX_WALLETS = 100
const MIB = 1024 * 1024
const RSS_STABILITY_TOLERANCE_BYTES = 16 * MIB
const RSS_STABILITY_TIMEOUT_MS = 15_000
const RSS_SAMPLE_INTERVAL_MS = 250
const RSS_STABILITY_SAMPLE_COUNT = 5
const MAX_UNLOCK_DURATION_MS = 30_000
const MAX_PEAK_RSS_DELTA_BYTES = 64 * MIB
const MAX_RETAINED_RSS_DELTA_BYTES = 32 * MIB

interface V1Envelope {
  readonly encryptedData: string
  readonly salt: string
  readonly iv: string
}

interface PreparedCredential {
  readonly zcashEnvelope: V1Envelope
  readonly multichainVault: Readonly<Record<string, unknown>>
}

interface SessionCredential extends PreparedCredential {
  readonly keyDomainId: string
  readonly credentialGenerationId: string
}

interface AuthenticatedCredentialPair {
  readonly zcash: EncryptedCredentialEnvelopeRecord
  readonly multichain: EncryptedCredentialEnvelopeRecord
}

interface ProcessEntry {
  readonly pid: number
  readonly parentPid: number
  readonly rssKib: number
  readonly command: string
}

interface BrowserRssSnapshot {
  readonly totalRssBytes: number
  readonly rssBytesByProcessType: Readonly<Record<string, number>>
  readonly processCountByType: Readonly<Record<string, number>>
}

const execFileAsync = promisify(execFile)

function parseProcessTable(value: string): readonly ProcessEntry[] {
  return value
    .split('\n')
    .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssKib: Number(match[3]),
      command: match[4]
    }))
}

function readChromiumProcessType(command: string): string {
  return command.match(/(?:^|\s)--type=([^\s]+)/)?.[1] ?? 'browser'
}

async function readTestBrowserRssSnapshot(): Promise<BrowserRssSnapshot> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('The resource budget process sampler requires macOS or Linux')
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 4 * MIB
  })
  const processes = parseProcessTable(stdout)
  const testProcesses = processes.filter(process =>
    process.command.includes('playwright_chromiumdev_profile')
  )
  const profiles = new Set(
    testProcesses
      .map(process => process.command.match(/--user-data-dir=([^\s]+)/)?.[1])
      .filter((profile): profile is string => profile !== undefined)
  )
  if (profiles.size !== 1) {
    throw new Error('The resource gate requires exactly one Playwright Chromium profile')
  }
  const [profile] = profiles
  const roots = testProcesses.filter(process =>
    process.command.includes(`--user-data-dir=${profile}`)
  )
  if (roots.length === 0) throw new Error('Unable to identify the Playwright Chromium process')

  const included = new Set(roots.map(process => process.pid))
  let previousSize = -1
  while (included.size !== previousSize) {
    previousSize = included.size
    for (const process of processes) {
      if (included.has(process.parentPid)) included.add(process.pid)
    }
  }
  const rssBytesByProcessType: Record<string, number> = {}
  const processCountByType: Record<string, number> = {}
  let totalRssBytes = 0
  for (const process of processes) {
    if (!included.has(process.pid)) continue
    const rssBytes = process.rssKib * 1024
    const processType = readChromiumProcessType(process.command)
    totalRssBytes += rssBytes
    rssBytesByProcessType[processType] = (rssBytesByProcessType[processType] ?? 0) + rssBytes
    processCountByType[processType] = (processCountByType[processType] ?? 0) + 1
  }
  return {
    totalRssBytes,
    rssBytesByProcessType: Object.freeze(rssBytesByProcessType),
    processCountByType: Object.freeze(processCountByType)
  }
}

async function waitForStableBrowserRss(): Promise<BrowserRssSnapshot> {
  const deadline = Date.now() + RSS_STABILITY_TIMEOUT_MS
  const samples: BrowserRssSnapshot[] = []
  while (Date.now() < deadline) {
    const snapshot = await readTestBrowserRssSnapshot()
    samples.push(snapshot)
    if (samples.length > RSS_STABILITY_SAMPLE_COUNT) samples.shift()
    if (samples.length === RSS_STABILITY_SAMPLE_COUNT) {
      const totals = samples.map(sample => sample.totalRssBytes)
      if (Math.max(...totals) - Math.min(...totals) <= RSS_STABILITY_TOLERANCE_BYTES) {
        return snapshot
      }
    }
    await new Promise(resolve => setTimeout(resolve, RSS_SAMPLE_INTERVAL_MS))
  }
  throw new Error('Playwright Chromium RSS did not reach a stable measurement window')
}

async function monitorPeakBrowserRss<T>(
  baseline: BrowserRssSnapshot,
  operation: () => Promise<T>
): Promise<{
  readonly result: T
  readonly baseline: BrowserRssSnapshot
  readonly peak: BrowserRssSnapshot
}> {
  let stopped = false
  let peak = baseline
  const sampler = (async () => {
    while (!stopped) {
      const snapshot = await readTestBrowserRssSnapshot()
      if (snapshot.totalRssBytes > peak.totalRssBytes) peak = snapshot
      await new Promise(resolve => setTimeout(resolve, RSS_SAMPLE_INTERVAL_MS))
    }
  })()
  let result!: T
  try {
    result = await operation()
  } finally {
    const finalSnapshot = await readTestBrowserRssSnapshot()
    if (finalSnapshot.totalRssBytes > peak.totalRssBytes) peak = finalSnapshot
    stopped = true
    await sampler
  }
  return { result, baseline, peak }
}

async function prepareCredential(page: Page): Promise<PreparedCredential> {
  return page.evaluate(
    async ({ mnemonic, password }) => {
      const encoder = new TextEncoder()
      const toBase64 = (value: Uint8Array) => btoa(String.fromCharCode(...Array.from(value)))
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const passwordKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
      )
      const encryptionKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
        passwordKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
      )
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        encoder.encode(JSON.stringify({ seedPhrase: mnemonic }))
      )

      const commandId = `keyring-command:resource-budget:${crypto.randomUUID()}`
      const response = await chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'multichain.conformance-execute',
        payload: {
          command: {
            protocolVersion: 2,
            commandId,
            engine: 'multichain',
            operation: 'credential.import',
            binding: {
              kind: 'credential',
              keyDomainId: 'key-domain:resource-budget-source',
              credentialGenerationId: 'credential-generation:resource-budget-source',
              globalUnlockEpoch: 'global-unlock:resource-budget-source'
            },
            deadlineAt: Date.now() + 120_000,
            payload: { mnemonic, password }
          }
        }
      })
      if (!response?.result?.ok || !response.result.value) {
        throw new Error('Unable to prepare the Multichain resource-budget vault')
      }
      return {
        zcashEnvelope: {
          encryptedData: toBase64(new Uint8Array(encrypted)),
          salt: toBase64(salt),
          iv: toBase64(iv)
        },
        multichainVault: response.result.value
      }
    },
    { mnemonic: MNEMONIC, password: PASSWORD }
  )
}

function credentialInventory(
  prepared: PreparedCredential,
  count: number
): readonly SessionCredential[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        keyDomainId: `key-domain:resource-budget:${index}`,
        credentialGenerationId: `credential-generation:resource-budget:${index}`,
        zcashEnvelope: prepared.zcashEnvelope,
        multichainVault: prepared.multichainVault
      })
    )
  )
}

async function unlockInventory(page: Page, credentials: readonly SessionCredential[]) {
  return page.evaluate(
    async ({ password, inventory }) => {
      const startedAt = performance.now()
      const response = await chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'session.conformance-unlock',
        payload: {
          input: {
            password,
            credentials: inventory,
            lastUserActivityAt: Date.now()
          }
        }
      })
      return { durationMs: performance.now() - startedAt, response }
    },
    { password: PASSWORD, inventory: credentials }
  )
}

async function prepareAuthenticatedCredentialPairs(
  prepared: PreparedCredential,
  count: number
): Promise<readonly AuthenticatedCredentialPair[]> {
  const zcashPayload = encodeV1EncryptedCredentialEnvelope(prepared.zcashEnvelope)
  const multichainPayload = new TextEncoder().encode(JSON.stringify(prepared.multichainVault))
  const createdAt = Date.now()
  const pairs: AuthenticatedCredentialPair[] = []
  for (let index = 0; index < count; index += 1) {
    const keyDomainId = parseKeyDomainId(`key-domain:resource-budget:${index}`)
    const credentialGenerationId = parseCredentialGenerationId(
      `credential-generation:resource-budget:${index}`
    )
    const transactionId = parseCredentialTransactionId(`transaction:resource-budget:${index}`)
    const zcashRef = parseEngineCredentialRef(`credential:resource-budget:${index}:zcash`)
    const multichainRef = parseEngineCredentialRef(`credential:resource-budget:${index}:multichain`)
    const pair = await authenticateSoftwareCredentialEnvelopePair(
      {
        zcash: {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'zcash',
            keyDomainId,
            credentialGenerationId,
            credentialRef: zcashRef,
            formatVersion: 1
          },
          encryptedPayload: zcashPayload,
          createdAt
        },
        multichain: {
          schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
          transactionId,
          aad: {
            schemaVersion: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
            engine: 'multichain',
            keyDomainId,
            credentialGenerationId,
            credentialRef: multichainRef,
            formatVersion: 1
          },
          encryptedPayload: multichainPayload,
          createdAt
        }
      },
      PASSWORD
    )
    pairs.push(pair)
  }
  return Object.freeze(pairs)
}

async function unlockAuthenticatedInventory(
  page: Page,
  pairs: readonly AuthenticatedCredentialPair[]
) {
  const startedAt = performance.now()
  const authenticationStartedAt = performance.now()
  const credentials: SessionCredential[] = []
  for (const pair of pairs) {
    const payloads = await unwrapSoftwareCredentialEnvelopePair(pair, PASSWORD)
    credentials.push(
      Object.freeze({
        keyDomainId: pair.zcash.aad.keyDomainId,
        credentialGenerationId: pair.zcash.aad.credentialGenerationId,
        zcashEnvelope: decodeV1EncryptedCredentialEnvelope(payloads.zcash),
        multichainVault: parseRawEncryptedVault(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloads.multichain))
        )
      })
    )
  }
  const authenticationDurationMs = performance.now() - authenticationStartedAt
  const session = await unlockInventory(page, credentials)
  return {
    durationMs: performance.now() - startedAt,
    authenticationDurationMs,
    sessionDurationMs: session.durationMs,
    response: session.response
  }
}

async function unlockMultichainOnly(page: Page, vault: Readonly<Record<string, unknown>>) {
  return page.evaluate(
    async ({ password, encryptedVault, walletCount }) => {
      const globalUnlockEpoch = 'global-unlock:resource-budget-multichain-only'
      const startedAt = performance.now()
      for (let index = 0; index < walletCount; index += 1) {
        const commandId = `keyring-command:resource-budget-multichain:${index}:${crypto.randomUUID()}`
        const response = await chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'multichain.conformance-execute',
          payload: {
            command: {
              protocolVersion: 2,
              commandId,
              engine: 'multichain',
              operation: 'credential.unlock',
              binding: {
                kind: 'credential',
                keyDomainId: `key-domain:resource-budget-multichain:${index}`,
                credentialGenerationId: `credential-generation:resource-budget-multichain:${index}`,
                globalUnlockEpoch
              },
              deadlineAt: Date.now() + 120_000,
              payload: { vault: encryptedVault, password }
            }
          }
        })
        if (!response?.result?.ok) {
          throw new Error(`Multichain-only resource benchmark failed at Wallet ${index + 1}`)
        }
      }
      return { durationMs: performance.now() - startedAt, globalUnlockEpoch }
    },
    { password: PASSWORD, encryptedVault: vault, walletCount: MAX_WALLETS }
  )
}

async function runMultichainStateControl(page: Page) {
  return page.evaluate(async walletCount => {
    const startedAt = performance.now()
    for (let index = 0; index < walletCount; index += 1) {
      const commandId = `keyring-command:resource-budget-state:${index}:${crypto.randomUUID()}`
      const response = await chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'multichain.conformance-execute',
        payload: {
          command: {
            protocolVersion: 2,
            commandId,
            engine: 'multichain',
            operation: 'credential.get-state',
            binding: {
              kind: 'credential',
              keyDomainId: `key-domain:resource-budget-state:${index}`,
              credentialGenerationId: `credential-generation:resource-budget-state:${index}`,
              globalUnlockEpoch: 'global-unlock:resource-budget-state'
            },
            deadlineAt: Date.now() + 120_000,
            payload: {}
          }
        }
      })
      if (!response?.result?.ok || response.result.value?.state !== 'locked') {
        throw new Error(`Multichain state control failed at request ${index + 1}`)
      }
    }
    return { durationMs: performance.now() - startedAt }
  }, MAX_WALLETS)
}

async function lockMultichainOnly(page: Page, globalUnlockEpoch: string): Promise<void> {
  const response = await page.evaluate(async epoch => {
    const commandId = `keyring-command:resource-budget-multichain-lock:${crypto.randomUUID()}`
    return chrome.runtime.sendMessage({
      type: 'WORKER_RPC',
      method: 'multichain.conformance-execute',
      payload: {
        command: {
          protocolVersion: 2,
          commandId,
          engine: 'multichain',
          operation: 'credential.lock-all',
          binding: { kind: 'global', globalUnlockEpoch: epoch },
          deadlineAt: Date.now() + 120_000,
          payload: {}
        }
      }
    })
  }, globalUnlockEpoch)
  expect(response).toMatchObject({ result: { ok: true, value: { state: 'locked' } } })
}

async function attestAndLock(page: Page, descriptor: unknown): Promise<void> {
  await expect(
    page.evaluate(
      value =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'session.conformance-attest',
          payload: { descriptor: value }
        }),
      descriptor
    )
  ).resolves.toMatchObject({ result: { unlockedCredentials: expect.any(Array) } })
  await expect(
    page.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'WORKER_RPC',
        method: 'session.conformance-lock',
        payload: {}
      })
    )
  ).resolves.toEqual({ result: true })
}

test('keeps 100 lightweight Multichain Worker roundtrips within the control budget', async ({
  popup
}) => {
  test.skip(
    process.env.RESOURCE_BUDGET_E2E !== '1',
    '100-Wallet KDF and memory benchmark is a release-gate workload'
  )
  test.setTimeout(300_000)
  await waitForBackgroundWalletInitialization(popup)
  const prepared = await prepareCredential(popup)

  const baseline = await waitForStableBrowserRss()
  const monitored = await monitorPeakBrowserRss(baseline, () => runMultichainStateControl(popup))
  const final = await waitForStableBrowserRss()
  const metrics = {
    requestCount: MAX_WALLETS,
    durationMs: Math.round(monitored.result.durationMs),
    baselineRssBytes: monitored.baseline.totalRssBytes,
    peakRssBytes: monitored.peak.totalRssBytes,
    finalRssBytes: final.totalRssBytes,
    peakRssDeltaBytes: monitored.peak.totalRssBytes - monitored.baseline.totalRssBytes,
    finalRssDeltaBytes: final.totalRssBytes - monitored.baseline.totalRssBytes,
    baselineRssBytesByProcessType: monitored.baseline.rssBytesByProcessType,
    peakRssBytesByProcessType: monitored.peak.rssBytesByProcessType,
    finalRssBytesByProcessType: final.rssBytesByProcessType,
    baselineProcessCountByType: monitored.baseline.processCountByType,
    peakProcessCountByType: monitored.peak.processCountByType,
    finalProcessCountByType: final.processCountByType
  }
  console.info(`[multichain-resource-control] ${JSON.stringify(metrics)}`)

  expect(monitored.result.durationMs).toBeLessThanOrEqual(10_000)
  expect(metrics.peakRssDeltaBytes).toBeLessThanOrEqual(32 * MIB)
  expect(metrics.finalRssDeltaBytes).toBeLessThanOrEqual(32 * MIB)
})

test('keeps 100 Multichain WASM sessions within the component resource budget', async ({
  popup
}, testInfo) => {
  test.skip(
    process.env.RESOURCE_BUDGET_E2E !== '1',
    '100-Wallet KDF and memory benchmark is a release-gate workload'
  )
  test.setTimeout(300_000)
  await waitForBackgroundWalletInitialization(popup)
  const prepared = await prepareCredential(popup)

  const baseline = await waitForStableBrowserRss()
  const monitored = await monitorPeakBrowserRss(baseline, () =>
    unlockMultichainOnly(popup, prepared.multichainVault)
  )
  await lockMultichainOnly(popup, monitored.result.globalUnlockEpoch)
  const locked = await waitForStableBrowserRss()
  const metrics = {
    walletCount: MAX_WALLETS,
    unlockDurationMs: Math.round(monitored.result.durationMs),
    baselineRssBytes: monitored.baseline.totalRssBytes,
    peakRssBytes: monitored.peak.totalRssBytes,
    lockedRssBytes: locked.totalRssBytes,
    peakRssDeltaBytes: monitored.peak.totalRssBytes - monitored.baseline.totalRssBytes,
    lockedRssDeltaBytes: locked.totalRssBytes - monitored.baseline.totalRssBytes,
    baselineRssBytesByProcessType: monitored.baseline.rssBytesByProcessType,
    peakRssBytesByProcessType: monitored.peak.rssBytesByProcessType,
    lockedRssBytesByProcessType: locked.rssBytesByProcessType,
    baselineProcessCountByType: monitored.baseline.processCountByType,
    peakProcessCountByType: monitored.peak.processCountByType,
    lockedProcessCountByType: locked.processCountByType
  }
  console.info(`[multichain-resource-budget] ${JSON.stringify(metrics)}`)
  await testInfo.attach('multichain-resource-budget.json', {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: 'application/json'
  })

  expect(monitored.result.durationMs).toBeLessThanOrEqual(MAX_UNLOCK_DURATION_MS)
  expect(metrics.peakRssDeltaBytes).toBeLessThanOrEqual(MAX_PEAK_RSS_DELTA_BYTES)
  expect(metrics.lockedRssDeltaBytes).toBeLessThanOrEqual(MAX_RETAINED_RSS_DELTA_BYTES)
})

test('keeps the 100-Wallet global unlock within the release resource budget', async ({
  popup
}, testInfo) => {
  test.skip(
    process.env.RESOURCE_BUDGET_E2E !== '1',
    '100-Wallet KDF and memory benchmark is a release-gate workload'
  )
  test.setTimeout(300_000)
  await waitForBackgroundWalletInitialization(popup)
  const prepared = await prepareCredential(popup)

  const warmup = await unlockInventory(popup, credentialInventory(prepared, 1))
  expect(warmup.response).toMatchObject({ result: { unlockedCredentials: [expect.any(Object)] } })
  await attestAndLock(popup, warmup.response.result)

  const authenticatedPairs = await prepareAuthenticatedCredentialPairs(prepared, MAX_WALLETS)

  const baseline = await waitForStableBrowserRss()
  const monitored = await monitorPeakBrowserRss(baseline, () =>
    unlockAuthenticatedInventory(popup, authenticatedPairs)
  )
  const benchmark = monitored.result
  expect(benchmark.response).toMatchObject({
    result: { unlockedCredentials: expect.any(Array) }
  })
  expect(benchmark.response.result?.unlockedCredentials).toHaveLength(MAX_WALLETS)
  if (!benchmark.response.result) throw new Error('Credential session descriptor is missing')
  await expect(
    popup.evaluate(
      descriptor =>
        chrome.runtime.sendMessage({
          type: 'WORKER_RPC',
          method: 'session.conformance-attest',
          payload: { descriptor }
        }),
      benchmark.response.result
    )
  ).resolves.toMatchObject({ result: { unlockedCredentials: expect.any(Array) } })

  const unlocked = await waitForStableBrowserRss()
  await attestAndLock(popup, benchmark.response.result)
  const locked = await waitForStableBrowserRss()
  const metrics = {
    walletCount: MAX_WALLETS,
    warmupDurationMs: Math.round(warmup.durationMs),
    unlockDurationMs: Math.round(benchmark.durationMs),
    authenticationDurationMs: Math.round(benchmark.authenticationDurationMs),
    sessionDurationMs: Math.round(benchmark.sessionDurationMs),
    baselineRssBytes: monitored.baseline.totalRssBytes,
    peakRssBytes: monitored.peak.totalRssBytes,
    unlockedRssBytes: unlocked.totalRssBytes,
    lockedRssBytes: locked.totalRssBytes,
    peakRssDeltaBytes: monitored.peak.totalRssBytes - monitored.baseline.totalRssBytes,
    unlockedRssDeltaBytes: unlocked.totalRssBytes - monitored.baseline.totalRssBytes,
    lockedRssDeltaBytes: locked.totalRssBytes - monitored.baseline.totalRssBytes,
    baselineRssBytesByProcessType: monitored.baseline.rssBytesByProcessType,
    peakRssBytesByProcessType: monitored.peak.rssBytesByProcessType,
    unlockedRssBytesByProcessType: unlocked.rssBytesByProcessType,
    lockedRssBytesByProcessType: locked.rssBytesByProcessType,
    baselineProcessCountByType: monitored.baseline.processCountByType,
    peakProcessCountByType: monitored.peak.processCountByType,
    unlockedProcessCountByType: unlocked.processCountByType,
    lockedProcessCountByType: locked.processCountByType
  }
  console.info(`[credential-session-resource-budget] ${JSON.stringify(metrics)}`)
  await testInfo.attach('credential-session-resource-budget.json', {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: 'application/json'
  })

  expect(benchmark.durationMs).toBeLessThanOrEqual(MAX_UNLOCK_DURATION_MS)
  expect(metrics.peakRssDeltaBytes).toBeLessThanOrEqual(MAX_PEAK_RSS_DELTA_BYTES)
  expect(metrics.unlockedRssDeltaBytes).toBeLessThanOrEqual(MAX_RETAINED_RSS_DELTA_BYTES)
  expect(metrics.lockedRssDeltaBytes).toBeLessThanOrEqual(MAX_RETAINED_RSS_DELTA_BYTES)
})
