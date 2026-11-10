import {
  Apdu,
  type DeviceManagementKit,
  type DeviceSessionId
} from '@ledgerhq/device-management-kit'
import BtcOld from '@ledgerhq/hw-app-btc/lib/BtcOld'
import { serializeTransactionOutputs } from '@ledgerhq/hw-app-btc/lib/serializeTransaction'
import { splitTransaction } from '@ledgerhq/hw-app-btc/lib/splitTransaction'
import { Buffer } from 'buffer'
import { Psbt, Transaction } from 'bitcoinjs-lib'
import type {
  LedgerDashSigningRequest,
  LedgerDashSigningResponse
} from '@/core/keyring/protocol/ledger-signing'
import {
  getLedgerDeviceName,
  openLedgerApp,
  type LedgerSessionOptions,
  withLedgerSession
} from './device'
import {
  assertDashHardwareMainnet,
  assertDashHardwareSignedTransactionMatchesReview,
  assertLedgerDashDeviceSupported,
  encodeLedgerDashMessageSignature,
  deriveLedgerDashP2pkh,
  LEDGER_DASH_APP_NAME,
  ledgerDashAccountPath,
  ledgerDashDevicePath,
  normalizeLedgerDashPublicKey,
  validateLedgerDashAccountPath,
  validateLedgerDashAddressPath
} from './dash-model'

const ACCOUNT_XPUB_VERSION = 0x0488b21e
const SIGHASH_ALL = 1

export interface LedgerDashAccountExport {
  readonly accountPath: string
  readonly xpub: string
  readonly address: string
  readonly publicKey: string
  readonly deviceModel: string
  readonly deviceName: string
  readonly appVersion: string
}

export type { LedgerDashSigningRequest, LedgerDashSigningResponse }

type LedgerDashDeviceOptions = LedgerSessionOptions & { readonly network: 'mainnet' | 'testnet' }

function assertMainnetExport(network: 'mainnet' | 'testnet'): void {
  if (network !== 'mainnet') throw new Error('Dash hardware wallets support mainnet only')
}

class DmkLedgerTransport {
  constructor(
    private readonly dmk: DeviceManagementKit,
    private readonly sessionId: DeviceSessionId,
    private readonly signal?: AbortSignal
  ) {}

  // BtcOld calls Transport.send. Reuse the open DMK session instead of a second WebHID transport.
  async send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data: Buffer = Buffer.alloc(0),
    statusList: readonly number[] = [0x9000]
  ): Promise<Buffer> {
    this.signal?.throwIfAborted()
    if (data.length >= 256) throw new Error('Ledger Dash APDU is too large')
    const response = await this.dmk.sendApdu({
      sessionId: this.sessionId,
      apdu: new Apdu(cla, ins, p1, p2, Uint8Array.from(data)).getRawApdu()
    })
    this.signal?.throwIfAborted()
    const status = (response.statusCode[0] << 8) | response.statusCode[1]
    if (!statusList.includes(status)) {
      throw new Error(
        `Ledger Dash app rejected the request (0x${status.toString(16).padStart(4, '0')})`
      )
    }
    return Buffer.concat([Buffer.from(response.data), Buffer.from(response.statusCode)])
  }
}

function accountExport(input: {
  readonly accountPath: string
  readonly xpub: string
  readonly publicKey: string
  readonly address: string
  readonly deviceModel: string
  readonly deviceName: string
  readonly appVersion: string
}): LedgerDashAccountExport {
  const derived = deriveLedgerDashP2pkh(input.xpub, false, 0)
  if (
    derived.address !== input.address ||
    derived.publicKey !== normalizeLedgerDashPublicKey(input.publicKey)
  ) {
    throw new Error('Ledger Dash account export does not match the device address')
  }
  return Object.freeze({
    accountPath: input.accountPath,
    xpub: input.xpub,
    address: derived.address,
    publicKey: `0x${derived.publicKey}`,
    deviceModel: input.deviceModel,
    deviceName: input.deviceName,
    appVersion: input.appVersion
  })
}

async function readDashAccount(
  app: BtcOld,
  accountPath: string,
  verifyReceiveAddress: boolean
): Promise<{ readonly xpub: string; readonly address: string; readonly publicKey: string }> {
  const xpub = await app.getWalletXpub({
    path: ledgerDashDevicePath(accountPath),
    xpubVersion: ACCOUNT_XPUB_VERSION
  })
  const derived = deriveLedgerDashP2pkh(xpub, false, 0)
  const receivePath = validateLedgerDashAddressPath(`${accountPath}/0/0`)
  const shown = await app.getWalletPublicKey(ledgerDashDevicePath(receivePath), {
    verify: verifyReceiveAddress,
    format: 'legacy'
  })
  if (
    shown.bitcoinAddress !== derived.address ||
    normalizeLedgerDashPublicKey(shown.publicKey) !== derived.publicKey
  ) {
    throw new Error('Ledger Dash address does not match the account xpub')
  }
  return { xpub, address: derived.address, publicKey: derived.publicKey }
}

export async function exportLedgerDashAccount(
  input: LedgerDashDeviceOptions & {
    readonly accountIndex: number
    readonly derivationPath?: string
  }
): Promise<LedgerDashAccountExport> {
  assertMainnetExport(input.network)
  const accountPath = input.derivationPath
    ? validateLedgerDashAccountPath(input.derivationPath)
    : ledgerDashAccountPath(input.accountIndex)
  return withLedgerSession(input, async ({ dmk, sessionId, device }) => {
    assertLedgerDashDeviceSupported(device.deviceModel.model)
    const appVersion = await openLedgerApp(
      dmk,
      sessionId,
      LEDGER_DASH_APP_NAME,
      input.signal,
      input.onInteraction
    )
    const app = new BtcOld(new DmkLedgerTransport(dmk, sessionId, input.signal) as never)
    const exported = await readDashAccount(app, accountPath, true)
    return accountExport({
      accountPath,
      ...exported,
      deviceModel: device.deviceModel.model,
      deviceName: getLedgerDeviceName(device.deviceModel.model, device.name),
      appVersion
    })
  })
}

export async function exportLedgerDashAccounts(
  paths: readonly string[],
  options: LedgerDashDeviceOptions
): Promise<readonly LedgerDashAccountExport[]> {
  assertMainnetExport(options.network)
  if (paths.length === 0) return Object.freeze([])
  const accountPaths = paths.map(validateLedgerDashAccountPath)
  if (new Set(accountPaths).size !== accountPaths.length) {
    throw new Error('Duplicate Ledger Dash account path')
  }
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    assertLedgerDashDeviceSupported(device.deviceModel.model)
    const appVersion = await openLedgerApp(
      dmk,
      sessionId,
      LEDGER_DASH_APP_NAME,
      options.signal,
      options.onInteraction
    )
    const app = new BtcOld(new DmkLedgerTransport(dmk, sessionId, options.signal) as never)
    const deviceModel = device.deviceModel.model
    const deviceName = getLedgerDeviceName(deviceModel, device.name)
    const accounts: LedgerDashAccountExport[] = []
    for (const accountPath of accountPaths) {
      options.signal?.throwIfAborted()
      const exported = await readDashAccount(app, accountPath, false)
      accounts.push(
        accountExport({ ...exported, accountPath, deviceModel, deviceName, appVersion })
      )
    }
    return Object.freeze(accounts)
  })
}

function dashPayment(psbtBase64: string, accountPath: string) {
  let psbt: Psbt
  try {
    psbt = Psbt.fromBase64(psbtBase64)
  } catch {
    throw new Error('Dash review PSBT is invalid')
  }
  const unsigned = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer())
  if (unsigned.ins.length === 0 || unsigned.outs.length === 0) {
    throw new Error('Dash review PSBT is invalid')
  }
  const inputs = unsigned.ins.map((input, index) => {
    const previous = psbt.data.inputs[index]?.nonWitnessUtxo
    const derivation = psbt.data.inputs[index]?.bip32Derivation?.find(item =>
      item.path.startsWith(`${accountPath}/`)
    )
    if (!previous || !derivation) {
      throw new Error('Dash hardware signing requires a P2PKH input from this account')
    }
    return {
      previous: splitTransaction(Buffer.from(previous).toString('hex'), false),
      index: input.index,
      sequence: input.sequence,
      keyset: ledgerDashDevicePath(validateLedgerDashAddressPath(derivation.path))
    }
  })
  const changePaths = psbt.data.outputs.flatMap(output =>
    (output.bip32Derivation ?? [])
      .filter(item => item.path.startsWith(`${accountPath}/1/`))
      .map(item => ledgerDashDevicePath(validateLedgerDashAddressPath(item.path)))
  )
  if (new Set(changePaths).size > 1)
    throw new Error('Dash review PSBT has more than one change path')
  return {
    inputs: inputs.map(
      input =>
        [input.previous, input.index, null, input.sequence] as [
          ReturnType<typeof splitTransaction>,
          number,
          null,
          number
        ]
    ),
    associatedKeysets: inputs.map(input => input.keyset),
    changePath: changePaths[0],
    outputScriptHex: serializeTransactionOutputs(
      splitTransaction(unsigned.toHex(), false)
    ).toString('hex'),
    lockTime: unsigned.locktime
  }
}

export async function signLedgerDashRequest(
  request: LedgerDashSigningRequest,
  options: LedgerSessionOptions
): Promise<LedgerDashSigningResponse> {
  if (request.kind === 'dash-message') {
    assertDashHardwareMainnet(request.chainId)
    const accountPath = validateLedgerDashAccountPath(request.accountPath)
    const messageHex = Buffer.from(request.message, 'utf8').toString('hex')
    return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
      assertLedgerDashDeviceSupported(device.deviceModel.model)
      await openLedgerApp(
        dmk,
        sessionId,
        LEDGER_DASH_APP_NAME,
        options.signal,
        options.onInteraction
      )
      const app = new BtcOld(new DmkLedgerTransport(dmk, sessionId, options.signal) as never)
      const exported = await readDashAccount(app, accountPath, false)
      if (exported.address !== request.expectedAddress) {
        throw new Error('Connected Ledger Dash account does not match the review')
      }
      try {
        const signed = await app.signMessage({
          path: ledgerDashDevicePath(`${accountPath}/0/0`),
          messageHex
        })
        return Object.freeze({
          kind: 'dash-message',
          signature: encodeLedgerDashMessageSignature(signed.v, signed.r, signed.s)
        })
      } catch (error) {
        const status =
          error instanceof Error ? error.message.match(/0x[0-9a-f]{4}/i)?.[0] : undefined
        console.info(
          'Dash message signing',
          error instanceof Error ? error.name : 'Error',
          status ?? 'no-status'
        )
        throw error
      }
    })
  }
  assertDashHardwareMainnet(request.chainId)
  const accountPath = validateLedgerDashAccountPath(request.accountPath)
  const expected = deriveLedgerDashP2pkh(request.xpub, false, 0)
  if (expected.address !== request.expectedAddress) {
    throw new Error('Ledger Dash account does not match the review')
  }
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    assertLedgerDashDeviceSupported(device.deviceModel.model)
    await openLedgerApp(dmk, sessionId, LEDGER_DASH_APP_NAME, options.signal, options.onInteraction)
    const app = new BtcOld(new DmkLedgerTransport(dmk, sessionId, options.signal) as never)
    const exported = await readDashAccount(app, accountPath, false)
    if (exported.xpub !== request.xpub || exported.address !== request.expectedAddress) {
      throw new Error('Connected Ledger Dash account does not match the review')
    }
    const payment = dashPayment(request.psbtBase64, accountPath)
    const signedTransactionHex = await app.createPaymentTransaction({
      inputs: payment.inputs,
      associatedKeysets: payment.associatedKeysets,
      ...(payment.changePath === undefined ? {} : { changePath: payment.changePath }),
      outputScriptHex: payment.outputScriptHex,
      lockTime: payment.lockTime,
      sigHashType: SIGHASH_ALL,
      segwit: false,
      additionals: []
    })
    assertDashHardwareSignedTransactionMatchesReview(
      request.psbtBase64,
      signedTransactionHex,
      request.chainId
    )
    return Object.freeze({ kind: 'dash-psbt', signedTransactionHex })
  })
}
