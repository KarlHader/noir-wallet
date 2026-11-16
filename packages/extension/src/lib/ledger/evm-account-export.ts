import { isAddress, keccak256, type Hex } from 'viem'

export interface LedgerEvmAccountExport {
  readonly derivationPath: string
  readonly publicKey: string
  readonly address: string
  readonly deviceModel: string
  readonly deviceName: string
  readonly appVersion: string
}

interface LedgerEvmAddress {
  readonly address: string
  readonly publicKey: string
}

export function validateLedgerEvmAccount(account: LedgerEvmAddress): LedgerEvmAddress {
  if (!isAddress(account.address) || !/^(?:0x)?04[0-9a-fA-F]{128}$/.test(account.publicKey)) {
    throw new Error('Ledger returned an invalid EVM account')
  }
  const rawPublicKey = account.publicKey.replace(/^0x/, '')
  const derivedAddress = `0x${keccak256(`0x${rawPublicKey.slice(2)}` as Hex).slice(-40)}`
  if (derivedAddress.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error('Ledger EVM public key does not match its address')
  }
  return {
    publicKey: `0x${rawPublicKey}`,
    address: account.address.toLowerCase()
  }
}

export async function collectLedgerEvmAccounts(input: {
  readonly paths: readonly { readonly derivationPath: string; readonly path: string }[]
  readonly readAddress: (path: string) => Promise<LedgerEvmAddress>
  readonly readApp: () => Promise<{ readonly name: string; readonly version: string } | null>
  readonly deviceModel: string
  readonly deviceName: string
  readonly signal?: AbortSignal
}): Promise<readonly LedgerEvmAccountExport[]> {
  const results: LedgerEvmAccountExport[] = []
  let appVersion: string | undefined
  for (const { derivationPath, path } of input.paths) {
    input.signal?.throwIfAborted()
    const account = validateLedgerEvmAccount(await input.readAddress(path))
    input.signal?.throwIfAborted()
    if (appVersion === undefined) {
      input.signal?.throwIfAborted()
      const app = await input.readApp()
      input.signal?.throwIfAborted()
      if (app?.name !== 'Ethereum') {
        throw new Error('Unable to verify the Ledger Ethereum app')
      }
      appVersion = app.version
    }
    results.push(
      Object.freeze({
        derivationPath,
        ...account,
        deviceModel: input.deviceModel,
        deviceName: input.deviceName,
        appVersion
      })
    )
  }
  return results
}
