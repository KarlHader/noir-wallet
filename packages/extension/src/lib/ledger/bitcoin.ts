import {
  DefaultDescriptorTemplate,
  DefaultWallet,
  SignerBtcBuilder
} from '@ledgerhq/device-signer-kit-bitcoin'
import { Buffer } from 'buffer'
import { Psbt } from 'bitcoinjs-lib'
import type {
  LedgerBitcoinSigningRequest,
  LedgerBitcoinSigningResponse
} from '@/core/keyring/protocol/ledger-signing'
import {
  getLedgerDeviceName,
  openLedgerApp,
  runLedgerAction,
  withLedgerSession,
  type LedgerSessionOptions
} from './device'
import {
  deriveLedgerBitcoinAddress,
  ledgerBitcoinAppName,
  ledgerBip322MessagePsbt,
  mergeLedgerBitcoinPartialSignature,
  networkConfig,
  supportsLedgerBitcoinBip322
} from './bitcoin-model'

export { deriveLedgerBitcoinAddress, verifyLedgerBitcoinBip322Signature } from './bitcoin-model'
export type {
  LedgerBitcoinSigningRequest,
  LedgerBitcoinSigningResponse
} from '@/core/keyring/protocol/ledger-signing'

export interface LedgerBitcoinAccountExport {
  readonly accountPath: string
  readonly xpub: string
  readonly masterFingerprintHex: string
  readonly address: string
  readonly publicKey: string
  readonly deviceModel: string
  readonly deviceName: string
  readonly appVersion: string
}

type LedgerBitcoinDeviceOptions = LedgerSessionOptions

function accountPath(network: 'mainnet' | 'testnet', accountIndex: number): string {
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > 0x7fffffff) {
    throw new Error('Invalid Ledger Bitcoin account index')
  }
  return `m/84'/${network === 'mainnet' ? 0 : 1}'/${accountIndex}'`
}

function normalizeAccountPath(path: string, network: 'mainnet' | 'testnet'): string {
  const match = new RegExp(`^m/84'/${network === 'mainnet' ? 0 : 1}'/((?:0|[1-9][0-9]*))'$`).exec(
    path
  )
  if (!match || Number(match[1]) > 0x7fffffff) {
    throw new Error('Unsupported Ledger Bitcoin account path')
  }
  return path.slice(2)
}

export async function exportLedgerBitcoinAccount(
  input: LedgerBitcoinDeviceOptions & {
    readonly network: 'mainnet' | 'testnet'
    readonly accountIndex: number
    readonly derivationPath?: string
  }
): Promise<LedgerBitcoinAccountExport> {
  const derivationPath = input.derivationPath ?? accountPath(input.network, input.accountIndex)
  const path = normalizeAccountPath(derivationPath, input.network)
  return withLedgerSession(input, async ({ dmk, sessionId, device }) => {
    const appVersion = await openLedgerApp(
      dmk,
      sessionId,
      ledgerBitcoinAppName(input.network),
      input.signal,
      input.onInteraction
    )
    const signer = new SignerBtcBuilder({ dmk, sessionId }).build()
    const fingerprint = await runLedgerAction(
      signer.getMasterFingerprint({ skipOpenApp: true }),
      input.onInteraction,
      'bitcoin_fingerprint',
      input.signal
    )
    const exported = await runLedgerAction(
      signer.getExtendedPublicKey(path, { checkOnDevice: true, skipOpenApp: true }),
      input.onInteraction,
      'bitcoin_xpub',
      input.signal
    )
    const derived = deriveLedgerBitcoinAddress(exported.extendedPublicKey, input.network, false, 0)
    const wallet = new DefaultWallet(path, DefaultDescriptorTemplate.NATIVE_SEGWIT)
    const confirmed = await runLedgerAction(
      signer.getWalletAddress(wallet, 0, { checkOnDevice: true, skipOpenApp: true }),
      input.onInteraction,
      'bitcoin_address',
      input.signal
    )
    if (confirmed.address !== derived.address || fingerprint.masterFingerprint.length !== 4) {
      throw new Error('Ledger Bitcoin account export does not match the device address')
    }
    return Object.freeze({
      accountPath: derivationPath,
      xpub: exported.extendedPublicKey,
      masterFingerprintHex: Buffer.from(fingerprint.masterFingerprint).toString('hex'),
      address: derived.address,
      publicKey: derived.publicKey,
      deviceModel: device.deviceModel.model,
      deviceName: getLedgerDeviceName(device.deviceModel.model, device.name),
      appVersion
    })
  })
}

export async function exportLedgerBitcoinAccounts(
  paths: readonly string[],
  options: LedgerBitcoinDeviceOptions & { readonly network: 'mainnet' | 'testnet' }
): Promise<readonly LedgerBitcoinAccountExport[]> {
  if (paths.length === 0) return Object.freeze([])
  const normalized = paths.map(path => normalizeAccountPath(path, options.network))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Duplicate Ledger Bitcoin account path')
  }
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    const appVersion = await openLedgerApp(
      dmk,
      sessionId,
      ledgerBitcoinAppName(options.network),
      options.signal,
      options.onInteraction
    )
    const signer = new SignerBtcBuilder({ dmk, sessionId }).build()
    const fingerprint = await runLedgerAction(
      signer.getMasterFingerprint({ skipOpenApp: true }),
      options.onInteraction,
      'bitcoin_fingerprint',
      options.signal
    )
    if (fingerprint.masterFingerprint.length !== 4) {
      throw new Error('Invalid Ledger Bitcoin fingerprint')
    }
    const masterFingerprintHex = Buffer.from(fingerprint.masterFingerprint).toString('hex')
    const deviceModel = device.deviceModel.model
    const deviceName = getLedgerDeviceName(deviceModel, device.name)
    const accounts: LedgerBitcoinAccountExport[] = []
    for (let index = 0; index < paths.length; index += 1) {
      const exported = await runLedgerAction(
        signer.getExtendedPublicKey(normalized[index], {
          checkOnDevice: false,
          skipOpenApp: true
        }),
        options.onInteraction,
        'bitcoin_xpub',
        options.signal
      )
      const derived = deriveLedgerBitcoinAddress(
        exported.extendedPublicKey,
        options.network,
        false,
        0
      )
      accounts.push(
        Object.freeze({
          accountPath: paths[index],
          xpub: exported.extendedPublicKey,
          masterFingerprintHex,
          address: derived.address,
          publicKey: derived.publicKey,
          deviceModel,
          deviceName,
          appVersion
        })
      )
    }
    return Object.freeze(accounts)
  })
}

export async function signLedgerBitcoinRequest(
  request: LedgerBitcoinSigningRequest,
  options: LedgerBitcoinDeviceOptions
): Promise<LedgerBitcoinSigningResponse> {
  const path = normalizeAccountPath(request.accountPath, request.network)
  if (!/^[0-9a-fA-F]{8}$/.test(request.masterFingerprintHex))
    throw new Error('Invalid Ledger Bitcoin fingerprint')
  return withLedgerSession(options, async ({ dmk, sessionId }) => {
    const appVersion = await openLedgerApp(
      dmk,
      sessionId,
      ledgerBitcoinAppName(request.network),
      options.signal,
      options.onInteraction
    )
    if (request.kind === 'bip322-simple' && !supportsLedgerBitcoinBip322(appVersion)) {
      throw new Error('Ledger Bitcoin App 2.1.3 or newer is required for BIP322 message signing')
    }
    const signer = new SignerBtcBuilder({ dmk, sessionId }).build()
    const fingerprint = await runLedgerAction(
      signer.getMasterFingerprint({ skipOpenApp: true }),
      options.onInteraction,
      'bitcoin_fingerprint',
      options.signal
    )
    if (
      Buffer.from(fingerprint.masterFingerprint).toString('hex') !==
      request.masterFingerprintHex.toLowerCase()
    ) {
      throw new Error('Connected Ledger does not match the approved Bitcoin account')
    }
    const wallet = new DefaultWallet(path, DefaultDescriptorTemplate.NATIVE_SEGWIT)
    const address = await runLedgerAction(
      signer.getWalletAddress(wallet, 0, { skipOpenApp: true }),
      options.onInteraction,
      'bitcoin_verify_address',
      options.signal
    )
    if (address.address !== request.expectedAddress)
      throw new Error('Connected Ledger Bitcoin address does not match')
    const psbt =
      request.kind === 'psbt'
        ? Psbt.fromBase64(request.psbtBase64, { network: networkConfig(request.network) })
        : await (async () => {
            const exported = await runLedgerAction(
              signer.getExtendedPublicKey(path, { skipOpenApp: true }),
              options.onInteraction,
              'bitcoin_xpub',
              options.signal
            )
            const derived = deriveLedgerBitcoinAddress(
              exported.extendedPublicKey,
              request.network,
              false,
              0
            )
            if (derived.address !== request.expectedAddress)
              throw new Error('Ledger Bitcoin public account mismatch')
            return ledgerBip322MessagePsbt(
              request.message,
              request.expectedAddress,
              derived.publicKey,
              request.masterFingerprintHex,
              request.accountPath,
              request.network
            )
          })()
    const signatures = await runLedgerAction(
      signer.signPsbt(wallet, psbt, { skipOpenApp: true }),
      options.onInteraction,
      'bitcoin_sign_psbt',
      options.signal
    )
    if (signatures.length === 0 && request.kind !== 'psbt')
      throw new Error('Ledger did not sign any Bitcoin input')
    for (const signature of signatures) {
      if (
        !('signature' in signature) ||
        !('pubkey' in signature) ||
        !Number.isSafeInteger(signature.inputIndex) ||
        signature.inputIndex < 0 ||
        signature.inputIndex >= psbt.inputCount
      ) {
        throw new Error('Ledger returned an unsupported Bitcoin signature')
      }
      const publicKey = Buffer.from(signature.pubkey)
      const derivation = psbt.data.inputs[signature.inputIndex].bip32Derivation?.find(
        item =>
          Buffer.from(item.masterFingerprint).toString('hex') ===
            request.masterFingerprintHex.toLowerCase() &&
          item.path.startsWith(`${request.accountPath}/`) &&
          Buffer.from(item.pubkey).equals(publicKey)
      )
      if (!derivation || signature.signature.at(-1) !== 1) {
        throw new Error('Ledger signature does not match an approved Native SegWit input')
      }
      mergeLedgerBitcoinPartialSignature(
        psbt,
        signature.inputIndex,
        publicKey,
        Buffer.from(signature.signature)
      )
    }
    if (request.kind === 'psbt')
      return Object.freeze({ kind: 'psbt', signedPsbtBase64: psbt.toBase64() })
    psbt.finalizeInput(0)
    const witness = psbt.data.inputs[0].finalScriptWitness
    if (!witness) throw new Error('Ledger BIP322 witness is missing')
    return Object.freeze({ kind: 'bip322-simple', signature: `smp${witness.toString('base64')}` })
  })
}
