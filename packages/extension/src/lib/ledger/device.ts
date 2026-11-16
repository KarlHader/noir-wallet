import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  DeviceModelId,
  GetAppAndVersionCommand,
  OpenAppDeviceAction,
  isSuccessCommandResult,
  type DeviceManagementKit,
  type DiscoveredDevice,
  type ExecuteDeviceActionReturnType,
  type LoggerSubscriberService
} from '@ledgerhq/device-management-kit'
import {
  SignerZcashBuilder,
  type PcztTransaction,
  type SignerZcash,
  type SignPcztTransactionResult
} from '@ledgerhq/device-signer-kit-zcash'
import { webHidIdentifier, webHidTransportFactory } from '@ledgerhq/device-transport-kit-web-hid'
import { webBleIdentifier, webBleTransportFactory } from '@ledgerhq/device-transport-kit-web-ble'
import { firstValueFrom, Observable, takeUntil, timeout, type Subscription } from 'rxjs'
import { bytesToBase64, base64ToBytes } from '@/lib/bytes'
import { normalizeLedgerTransparentSignature } from '@/lib/ledger/signature'
import type { Network } from '@/types'
import type { LedgerPcztSignatures, LedgerSigningPayload } from '@/core/worker/types'
import { logger } from '@/lib/logger'
import { getLedgerAccountPath } from '@/lib/zcash-derivation'
import { openAndVerifyLedgerApp } from './app-session'
import {
  assertLedgerZcashAppVersion,
  ledgerZcashTransactionBranchId
} from '@/lib/zcash-hardware-compatibility'

export type LedgerTransport = 'usb' | 'bluetooth'

export interface LedgerAccountExport {
  ufvk: string
  deviceModel: string
  deviceName: string
  appVersion: string
}

export function parseLedgerSigningPayload(value: unknown): LedgerSigningPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Ledger signing payload')
  }
  const record = value as Record<string, unknown>
  ledgerZcashTransactionBranchId(record.transaction)
  if (
    typeof record.transaction !== 'object' ||
    record.transaction === null ||
    !Array.isArray(record.orchardSignatureIndices) ||
    !Array.isArray(record.ironwoodSignatureIndices) ||
    record.orchardSignatureIndices.length > 1024 ||
    record.ironwoodSignatureIndices.length > 1024 ||
    [...record.orchardSignatureIndices, ...record.ironwoodSignatureIndices].some(
      index => !Number.isSafeInteger(index) || index < 0
    )
  ) {
    throw new Error('Invalid Ledger signing payload')
  }
  return {
    transaction: record.transaction,
    orchardSignatureIndices: record.orchardSignatureIndices,
    ironwoodSignatureIndices: record.ironwoodSignatureIndices
  }
}

const BLUETOOTH_DEVICE_MODELS = new Set<DeviceModelId>([
  DeviceModelId.NANO_X,
  DeviceModelId.STAX,
  DeviceModelId.FLEX,
  DeviceModelId.APEX
])

export function getLedgerDeviceName(deviceModel?: string, deviceName?: string): string {
  if (deviceName) return deviceName
  switch (deviceModel) {
    case DeviceModelId.NANO_SP:
      return 'Ledger Nano S Plus'
    case DeviceModelId.NANO_X:
      return 'Ledger Nano X'
    case DeviceModelId.STAX:
      return 'Ledger Stax'
    case DeviceModelId.FLEX:
      return 'Ledger Flex'
    case DeviceModelId.APEX:
      return 'Ledger Nano Gen5'
    default:
      return 'Ledger'
  }
}

export function ledgerSupportsBluetooth(deviceModel?: string): boolean {
  return BLUETOOTH_DEVICE_MODELS.has(deviceModel as DeviceModelId)
}

const DISCOVERY_TIMEOUT_MS = 60_000
const ACTION_TIMEOUT_MS = 5 * 60_000
const LEDGER_TRANSPARENT_INPUT_DATA_ERROR = 'LedgerPcztTransparentInputDataError'

let dmkInstance: DeviceManagementKit | null = null

interface LedgerCommandTrace {
  command: string
}

let lastLedgerCommand: LedgerCommandTrace | undefined

const PCZT_COMMAND_BY_INS: Record<string, string> = {
  '52': 'PcztHeader',
  '53': 'PcztTransparentInput',
  '54': 'PcztTransparentOutput',
  '55': 'SignPcztTransparent',
  '56': 'PcztOrchardAction',
  '57': 'SignPcztOrchard',
  '58': 'PcztIronwoodAction',
  '59': 'SignPcztIronwood'
}

function pcztCommandFromApdu(apdu: string): LedgerCommandTrace | undefined {
  if (!/^e0[0-9a-f]{8}/i.test(apdu)) return undefined
  const command = PCZT_COMMAND_BY_INS[apdu.slice(2, 4).toLowerCase()]
  if (!command) return undefined
  return { command }
}

const ledgerCommandTracker: LoggerSubscriberService = {
  log(_level, message, options) {
    const command = /^\[sendCommand\]\s+(.+)$/.exec(message)?.[1]
    // DMK also logs `[sendCommand] result` and `[sendCommand] error` after the
    // command name. Those are events, not commands, and must not overwrite the
    // APDU stage that failed.
    if (command && command !== 'result' && command !== 'error') {
      lastLedgerCommand = { command }
      return
    }

    // Device actions skip the command-name log; inspect only the APDU header.
    const outgoingApdu = /^\[will send APDU\]\s+~\.\.\.>\s+([0-9a-f]+)/i.exec(message)?.[1]
    const exchangeApdu =
      options.data?.type === 'apdu-exchange' && typeof options.data.apdu === 'string'
        ? options.data.apdu
        : undefined
    const pcztCommand = pcztCommandFromApdu(exchangeApdu ?? outgoingApdu ?? '')
    if (pcztCommand) {
      lastLedgerCommand = pcztCommand
    }
  }
}

export function getLedgerDmk(): DeviceManagementKit {
  if (!dmkInstance) {
    dmkInstance = new DeviceManagementKitBuilder()
      .addTransport(webHidTransportFactory)
      .addTransport(webBleTransportFactory)
      // Track only command names for actionable device errors.
      .addLogger(ledgerCommandTracker)
      .build()
  }
  return dmkInstance
}

const getDmk = getLedgerDmk

function transportIdentifier(transport: LedgerTransport) {
  return transport === 'usb' ? webHidIdentifier : webBleIdentifier
}

const LEDGER_ERROR_MESSAGES: Record<string, string> = {
  InsNotSupportedError:
    'This Zcash app does not support shielded operations. Install the Zcash Shielded app via Ledger Wallet.',
  ClaNotSupportedError:
    'The Zcash app did not recognize this command. Make sure the Zcash app is open on your Ledger.',
  ConditionOfUseNotSatisfiedError: 'Request was rejected on the Ledger device.',
  SecurityStatusNotSatisfiedError:
    'The device is locked or access is denied. Unlock your Ledger and try again.',
  UnsupportedV6TransactionError:
    'This transaction format is not supported by the current Zcash app version.'
}

interface LedgerErrorDetails {
  tag?: string
  code?: string
  message: string
}

function getErrorMessage(value: unknown): string | undefined {
  if (value instanceof Error && value.message) return value.message
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (typeof record.message === 'string' && record.message) return record.message
  return (
    getErrorMessage(record.originalError) ??
    getErrorMessage(record.cause) ??
    getErrorMessage(record.err)
  )
}

function describeLedgerError(error: unknown, zcashOperation: boolean): LedgerErrorDetails {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined
  const tag = typeof record?._tag === 'string' ? record._tag : undefined
  const code =
    typeof record?.errorCode === 'string' || typeof record?.errorCode === 'number'
      ? String(record.errorCode)
      : undefined
  const rawMessage = getErrorMessage(error) ?? 'Ledger operation failed'
  const mappedMessage = zcashOperation
    ? (LEDGER_ERROR_MESSAGES[rawMessage] ?? (tag ? LEDGER_ERROR_MESSAGES[tag] : undefined))
    : tag === 'ConditionOfUseNotSatisfiedError'
      ? 'Request was rejected on the Ledger device.'
      : tag === 'SecurityStatusNotSatisfiedError'
        ? 'Unlock your Ledger and try again.'
        : undefined

  return {
    tag,
    code,
    message: mappedMessage ?? rawMessage
  }
}

function isIncorrectDataError(details: LedgerErrorDetails): boolean {
  return (
    details.code?.toLowerCase() === '6a80' ||
    /IncorrectDataError|ZcashAppCommandError\/6a80/i.test(details.message)
  )
}

function formatLedgerError(
  details: LedgerErrorDetails,
  command: LedgerCommandTrace | undefined
): string {
  const diagnostic = [details.tag, details.code].filter(Boolean).join('/')
  const suffix = diagnostic ? ` (${diagnostic})` : ''
  if (isIncorrectDataError(details) && command?.command === 'PcztTransparentInput') {
    return (
      `${LEDGER_TRANSPARENT_INPUT_DATA_ERROR}: ` +
      `Ledger rejected the transparent input data${suffix}`
    )
  }
  return `${details.message}${suffix}`
}

export function shouldRebuildLedgerPczt(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(LEDGER_TRANSPARENT_INPUT_DATA_ERROR) ||
    /IncorrectDataError|ZcashAppCommandError\/6a80/i.test(message)
  )
}

export function isLedgerTransparentInputDataError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(LEDGER_TRANSPARENT_INPUT_DATA_ERROR)
}

function assertSupportedDevice(device: DiscoveredDevice): void {
  if (device.deviceModel.model === DeviceModelId.NANO_S) {
    throw new Error('Ledger Nano S is not supported by the Zcash app')
  }
}

export async function runLedgerAction<Output, ActionError, Intermediate>(
  action: ExecuteDeviceActionReturnType<Output, ActionError, Intermediate>,
  onInteraction?: (interaction: string) => void,
  operation = 'device_action',
  signal?: AbortSignal
): Promise<Output> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    lastLedgerCommand = undefined
    let subscription: Subscription | undefined
    const timer: { id?: ReturnType<typeof setTimeout> } = {}
    let finished = false
    const finish = (callback: () => void) => {
      if (finished) return
      finished = true
      if (timer.id !== undefined) globalThis.clearTimeout(timer.id)
      signal?.removeEventListener('abort', cancel)
      subscription?.unsubscribe()
      callback()
    }
    const stop = (error: Error) => {
      finish(() => reject(error))
      try {
        action.cancel()
      } catch {
        // The operation has already settled; cleanup must not mask its error.
      }
    }
    const cancel = () => stop(new DOMException('Ledger operation was cancelled', 'AbortError'))
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) {
      cancel()
      return
    }
    timer.id = globalThis.setTimeout(
      () => stop(new Error('Ledger operation timed out')),
      ACTION_TIMEOUT_MS
    )
    try {
      subscription = action.observable.subscribe({
        next: state => {
          if (state.status === DeviceActionStatus.Pending) {
            const interaction = state.intermediateValue
            if (
              interaction &&
              typeof interaction === 'object' &&
              'requiredUserInteraction' in interaction &&
              typeof interaction.requiredUserInteraction === 'string'
            ) {
              onInteraction?.(interaction.requiredUserInteraction)
            }
          } else if (state.status === DeviceActionStatus.Completed) {
            finish(() => resolve(state.output))
          } else if (state.status === DeviceActionStatus.Error) {
            const details = describeLedgerError(state.error, operation.startsWith('zcash_'))
            logger.warn(
              `[Ledger] ${operation} failed at ${lastLedgerCommand?.command ?? 'unknown'} (${details.code ?? 'unknown'})`
            )
            const wrappedError = new Error(formatLedgerError(details, lastLedgerCommand))
            Object.defineProperty(wrappedError, 'cause', { value: state.error })
            finish(() => reject(wrappedError))
          } else if (state.status === DeviceActionStatus.Stopped) {
            finish(() => reject(new Error('Ledger operation was cancelled')))
          }
        },
        error: error => finish(() => reject(error))
      })
      // A synchronous observable can finish before subscribe returns its handle.
      if (finished) subscription.unsubscribe()
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

const runAction = runLedgerAction

export async function openLedgerApp(
  dmk: DeviceManagementKit,
  sessionId: string,
  appName: string,
  signal?: AbortSignal,
  onInteraction?: (interaction: string) => void
): Promise<string> {
  return openAndVerifyLedgerApp(
    appName,
    name =>
      runLedgerAction(
        dmk.executeDeviceAction({
          sessionId,
          deviceAction: new OpenAppDeviceAction({ input: { appName: name } })
        }),
        onInteraction,
        'open_app',
        signal
      ),
    async () => {
      const app = await dmk.sendCommand({ sessionId, command: new GetAppAndVersionCommand() })
      return isSuccessCommandResult(app) ? app.data : null
    },
    signal
  )
}

export async function discoverLedger(
  transport: LedgerTransport,
  signal?: AbortSignal
): Promise<DiscoveredDevice> {
  signal?.throwIfAborted()
  const dmk = getDmk()
  try {
    const discovery = dmk
      .startDiscovering({ transport: transportIdentifier(transport) })
      .pipe(timeout(DISCOVERY_TIMEOUT_MS))
    const abort$ = signal
      ? new Observable<void>(subscriber => {
          const onAbort = () => subscriber.next()
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
          return () => signal.removeEventListener('abort', onAbort)
        })
      : undefined
    const device = await firstValueFrom(
      abort$ ? discovery.pipe(takeUntil(abort$)) : discovery
    ).catch(error => {
      signal?.throwIfAborted()
      throw error
    })
    return device
  } finally {
    await dmk.stopDiscovering().catch(() => {})
  }
}

export interface LedgerSessionOptions {
  readonly transport: LedgerTransport
  readonly device?: DiscoveredDevice
  readonly signal?: AbortSignal
  readonly onInteraction?: (interaction: string) => void
}

export async function withLedgerSession<T>(
  options: LedgerSessionOptions,
  action: (session: {
    dmk: DeviceManagementKit
    sessionId: string
    device: DiscoveredDevice
  }) => Promise<T>
): Promise<T> {
  const connect = async () => {
    options.signal?.throwIfAborted()
    const dmk = getDmk()
    const device = options.device ?? (await discoverLedger(options.transport, options.signal))
    const sessionId = await dmk.connect({
      device,
      sessionRefresherOptions: { isRefresherDisabled: true }
    })
    const abort = () => {
      void dmk.disconnect({ sessionId }).catch(() => {})
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      options.signal?.throwIfAborted()
      return await action({ dmk, sessionId, device })
    } finally {
      options.signal?.removeEventListener('abort', abort)
      await dmk.disconnect({ sessionId }).catch(() => {})
    }
  }
  // Ledger apps share one device transport; serialize sessions across signing tabs.
  return navigator.locks.request(
    'noir-ledger-device-session',
    { mode: 'exclusive', ...(options.signal ? { signal: options.signal } : {}) },
    connect
  )
}

async function withLedgerSigner<T>(
  transport: LedgerTransport,
  action: (args: {
    signer: SignerZcash
    device: DiscoveredDevice
    appVersion: string
  }) => Promise<T>,
  onInteraction?: (interaction: string) => void,
  preDiscovered?: DiscoveredDevice,
  signal?: AbortSignal
): Promise<T> {
  return withLedgerSession(
    { transport, device: preDiscovered, onInteraction, signal },
    async ({ dmk, sessionId, device }) => {
      assertSupportedDevice(device)
      const signer = new SignerZcashBuilder({ dmk, sessionId }).build()
      const config = await runAction(
        signer.getAppConfig(),
        onInteraction,
        'zcash_get_app_config',
        signal
      )
      assertLedgerZcashAppVersion(config.version)
      return await action({ signer, device, appVersion: config.version })
    }
  )
}

const LEDGER_BYTE_FIELDS = new Set([
  'pubkey',
  'seedFingerprint',
  'prevoutTxid',
  'scriptPubKey',
  'cvNet',
  'nullifier',
  'rk',
  'spendRecipient',
  'spendRho',
  'spendRseed',
  'alpha',
  'cmx',
  'ephemeralKey',
  'encCiphertext',
  'outCiphertext',
  'recipient',
  'rseed',
  'rcv',
  'anchor'
])
const LEDGER_BIGINT_FIELDS = new Set(['value', 'spendValue', 'valueBalance'])

function decodeLedgerWireValue(value: unknown, field?: string): unknown {
  if (
    LEDGER_BIGINT_FIELDS.has(field ?? '') &&
    (typeof value === 'number' || typeof value === 'string')
  ) {
    return BigInt(value)
  }
  if (Array.isArray(value)) {
    return LEDGER_BYTE_FIELDS.has(field ?? '')
      ? Uint8Array.from(value as number[])
      : value.map(entry => decodeLedgerWireValue(entry))
  }
  if (value && typeof value === 'object') {
    if ('__ledgerBytes' in value && typeof value.__ledgerBytes === 'string') {
      return base64ToBytes(value.__ledgerBytes)
    }
    if ('__ledgerBigInt' in value && typeof value.__ledgerBigInt === 'string') {
      return BigInt(value.__ledgerBigInt)
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeLedgerWireValue(entry, key)])
    )
  }
  return value
}

function toPcztTransaction(payload: LedgerSigningPayload): PcztTransaction {
  const transaction = decodeLedgerWireValue(payload.transaction)
  if (!transaction || typeof transaction !== 'object' || !('global' in transaction)) {
    throw new Error('Ledger transaction payload is invalid')
  }
  const tx = transaction as Record<string, unknown>
  const global = tx.global as Record<string, unknown>
  // serde-wasm-bindgen represents Rust `Option::None` as `undefined`, while the
  // Ledger signer wire encoder requires `null` for absent optional fields. If
  // left undefined it writes a present-field tag without the field bytes.
  global.fallbackLockTime ??= null
  // DMK SDK assumes these arrays are always present; default to [] for
  // shielded-only transactions where WASM omits the transparent bundle.
  if (!tx.transparentInputs) tx.transparentInputs = []
  if (!tx.transparentOutputs) tx.transparentOutputs = []
  if (Array.isArray(tx.transparentInputs)) {
    for (const input of tx.transparentInputs) {
      if (input && typeof input === 'object') {
        const inputRecord = input as Record<string, unknown>
        inputRecord.sequence ??= null
      }
    }
  }
  if (Array.isArray(tx.transparentOutputs)) {
    for (const output of tx.transparentOutputs) {
      if (output && typeof output === 'object') {
        const outputRecord = output as Record<string, unknown>
        outputRecord.derivation ??= null
      }
    }
  }
  return tx as unknown as PcztTransaction
}

function serializeSignatures(result: SignPcztTransactionResult): LedgerPcztSignatures {
  return {
    orchard: result.orchard.map(({ spendAuthSig }) => ({
      spendAuthSig: bytesToBase64(spendAuthSig)
    })),
    transparentInputSigs: result.transparentInputSigs.map(signature =>
      bytesToBase64(normalizeLedgerTransparentSignature(signature))
    ),
    ironwood: result.ironwood.map(({ spendAuthSig }) => ({
      spendAuthSig: bytesToBase64(spendAuthSig)
    }))
  }
}

export async function exportLedgerAccount(params: {
  transport: LedgerTransport
  network: Network
  accountIndex: number
  onInteraction?: (interaction: string) => void
  device?: DiscoveredDevice
  signal?: AbortSignal
}): Promise<LedgerAccountExport> {
  return withLedgerSigner(
    params.transport,
    async ({ signer, device, appVersion }) => {
      const viewingKey = await runAction(
        signer.getFullViewingKey(getLedgerAccountPath(params.network, params.accountIndex), {
          mode: 'ufvk'
        }),
        params.onInteraction,
        'zcash_get_full_viewing_key',
        params.signal
      )
      if (viewingKey.mode !== 'ufvk') {
        throw new Error('Ledger returned an unexpected viewing key format')
      }
      return {
        ufvk: viewingKey.fullViewingKey,
        deviceModel: device.deviceModel.model,
        deviceName: device.deviceModel.name,
        appVersion
      }
    },
    params.onInteraction,
    params.device,
    params.signal
  )
}

export async function signLedgerPczt(params: {
  transport: LedgerTransport
  payload: LedgerSigningPayload
  onInteraction?: (interaction: string) => void
  device?: DiscoveredDevice
  signal?: AbortSignal
}): Promise<LedgerPcztSignatures> {
  return withLedgerSigner(
    params.transport,
    async ({ signer, appVersion }) => {
      const transaction = toPcztTransaction(params.payload)
      assertLedgerZcashAppVersion(appVersion, transaction.global.consensusBranchId)
      lastLedgerCommand = undefined
      const result = await runAction(
        signer.signPcztTransaction(transaction),
        params.onInteraction,
        'zcash_sign_pczt_transaction',
        params.signal
      )
      return serializeSignatures(result)
    },
    params.onInteraction,
    params.device,
    params.signal
  )
}
