import { validateLedgerNearDerivationPath } from '@/core/wallet/ledger-derivation-path'

export function ledgerNearPathBytes(path: string): Uint8Array {
  const components = validateLedgerNearDerivationPath(path).slice(2).split('/')
  const bytes = new Uint8Array(20)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < components.length; index += 1) {
    view.setUint32(index * 4, Number(components[index].slice(0, -1)) | 0x80000000, false)
  }
  return bytes
}

export function ledgerNearPublicKeyParameters(path: string, displayAndConfirm: boolean) {
  // NEAR uses P1=0 for display and P1=1 for silent reads, unlike other Ledger apps.
  return { p1: displayAndConfirm ? 0 : 1, data: ledgerNearPathBytes(path) }
}
