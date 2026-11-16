import { SignerEthBuilder } from '@ledgerhq/device-signer-kit-ethereum'
import { GetAppAndVersionCommand, isSuccessCommandResult } from '@ledgerhq/device-management-kit'
import { hexToBytes, isAddress, type Hex } from 'viem'
import type {
  LedgerEvmSigningRequest,
  LedgerEvmSigningResponse
} from '@/core/keyring/protocol/ledger-signing'
import { validateLedgerEvmDerivationPath } from '@/core/wallet/ledger-derivation-path'
import {
  getLedgerDeviceName,
  runLedgerAction,
  withLedgerSession,
  type LedgerSessionOptions
} from './device'
import {
  collectLedgerEvmAccounts,
  validateLedgerEvmAccount,
  type LedgerEvmAccountExport
} from './evm-account-export'

export type { LedgerEvmAccountExport } from './evm-account-export'

export type {
  LedgerEvmSigningRequest,
  LedgerEvmSigningResponse
} from '@/core/keyring/protocol/ledger-signing'

type LedgerEvmDeviceOptions = LedgerSessionOptions

function normalizePath(path: string): string {
  return validateLedgerEvmDerivationPath(path).slice(2)
}

export async function exportLedgerEvmAccounts(
  paths: readonly string[],
  options: LedgerEvmDeviceOptions
): Promise<readonly LedgerEvmAccountExport[]> {
  const normalizedPaths = paths.map(path => ({ derivationPath: path, path: normalizePath(path) }))
  if (normalizedPaths.length === 0) return []
  return withLedgerSession(options, async ({ dmk, sessionId, device }) => {
    const signer = new SignerEthBuilder({ dmk, sessionId }).build()
    return collectLedgerEvmAccounts({
      paths: normalizedPaths,
      readAddress: path =>
        runLedgerAction(
          signer.getAddress(path, { checkOnDevice: false }),
          options.onInteraction,
          'evm_get_address',
          options.signal
        ),
      readApp: async () => {
        const app = await dmk.sendCommand({ sessionId, command: new GetAppAndVersionCommand() })
        return isSuccessCommandResult(app) ? app.data : null
      },
      deviceModel: device.deviceModel.model,
      deviceName: getLedgerDeviceName(device.deviceModel.model, device.name),
      signal: options.signal
    })
  })
}

function formatSignature(
  signature: { readonly r: string; readonly s: string; readonly v: number },
  kind: LedgerEvmSigningRequest['kind']
): string {
  const r = signature.r.toLowerCase()
  const s = signature.s.toLowerCase()
  const parity = signature.v >= 27 ? signature.v - 27 : signature.v
  if (
    !/^0x[0-9a-f]{64}$/.test(r) ||
    !/^0x[0-9a-f]{64}$/.test(s) ||
    (parity !== 0 && parity !== 1)
  ) {
    throw new Error('Ledger returned an invalid EVM signature')
  }
  const recovery = kind === 'transaction' ? parity : parity + 27
  return `${r}${s.slice(2)}${recovery.toString(16).padStart(2, '0')}`
}

export async function exportLedgerEvmAccount(
  input: LedgerEvmDeviceOptions & {
    readonly accountIndex: number
    readonly derivationPath?: string
  }
): Promise<LedgerEvmAccountExport> {
  if (
    !Number.isSafeInteger(input.accountIndex) ||
    input.accountIndex < 0 ||
    input.accountIndex > 0x7fffffff
  ) {
    throw new Error('Invalid Ledger EVM account index')
  }
  const derivationPath = input.derivationPath ?? `m/44'/60'/0'/0/${input.accountIndex}`
  const path = normalizePath(derivationPath)
  return withLedgerSession(input, async ({ dmk, sessionId, device }) => {
    const signer = new SignerEthBuilder({ dmk, sessionId }).build()
    const account = await runLedgerAction(
      signer.getAddress(path, { checkOnDevice: true }),
      input.onInteraction,
      'evm_get_address',
      input.signal
    )
    const verified = validateLedgerEvmAccount(account)
    input.signal?.throwIfAborted()
    const app = await dmk.sendCommand({ sessionId, command: new GetAppAndVersionCommand() })
    input.signal?.throwIfAborted()
    if (!isSuccessCommandResult(app) || app.data.name !== 'Ethereum') {
      throw new Error('Unable to verify the Ledger Ethereum app')
    }
    return Object.freeze({
      derivationPath,
      ...verified,
      deviceModel: device.deviceModel.model,
      deviceName: getLedgerDeviceName(device.deviceModel.model, device.name),
      appVersion: app.data.version
    })
  })
}

export async function signLedgerEvmRequest(
  request: LedgerEvmSigningRequest,
  options: LedgerEvmDeviceOptions
): Promise<LedgerEvmSigningResponse> {
  const path = normalizePath(request.derivationPath)
  if (!isAddress(request.expectedAddress)) throw new Error('Invalid Ledger EVM account address')
  return withLedgerSession(options, async ({ dmk, sessionId }) => {
    const signer = new SignerEthBuilder({ dmk, sessionId }).build()
    const account = await runLedgerAction(
      signer.getAddress(path),
      options.onInteraction,
      'evm_verify_address',
      options.signal
    )
    if (account.address.toLowerCase() !== request.expectedAddress.toLowerCase()) {
      throw new Error('Connected Ledger does not match the approved EVM account')
    }
    let signature: { readonly r: string; readonly s: string; readonly v: number }
    if (request.kind === 'transaction') {
      if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(request.unsignedTransactionHex)) {
        throw new Error('Invalid Ledger EVM unsigned transaction')
      }
      signature = await runLedgerAction(
        signer.signTransaction(path, hexToBytes(request.unsignedTransactionHex as Hex)),
        options.onInteraction,
        'evm_sign_transaction',
        options.signal
      )
    } else if (request.kind === 'personal-sign') {
      if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(request.messageHex)) {
        throw new Error('Invalid Ledger EVM message')
      }
      signature = await runLedgerAction(
        signer.signMessage(path, hexToBytes(request.messageHex as Hex)),
        options.onInteraction,
        'evm_sign_message',
        options.signal
      )
    } else {
      signature = await runLedgerAction(
        signer.signTypedData(
          path,
          request.typedData as unknown as Parameters<typeof signer.signTypedData>[1]
        ),
        options.onInteraction,
        'evm_sign_typed_data',
        options.signal
      )
    }
    return Object.freeze({ signatureHex: formatSignature(signature, request.kind) })
  })
}
