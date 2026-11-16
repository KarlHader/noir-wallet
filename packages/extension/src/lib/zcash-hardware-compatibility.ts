export const MIN_KEYSTONE_ZCASH_FIRMWARE_VERSION = '3.2.2'

const NU7_BRANCH_ID = 0x77190ad9
const MIN_LEDGER_ZCASH_APP_VERSION = '3.9.2'
const MIN_LEDGER_NU7_APP_VERSION = '3.10.0'

export function ledgerZcashTransactionBranchId(transaction: unknown): number {
  if (!transaction || typeof transaction !== 'object') {
    throw new Error('Invalid Ledger transaction')
  }
  const global: unknown = Reflect.get(transaction, 'global')
  const branch: unknown =
    global && typeof global === 'object' ? Reflect.get(global, 'consensusBranchId') : undefined
  if (
    typeof branch !== 'number' ||
    !Number.isSafeInteger(branch) ||
    branch < 0 ||
    branch > 0xffffffff
  ) {
    throw new Error('Invalid Ledger consensus branch')
  }
  return branch
}

export function minimumLedgerZcashAppVersion(consensusBranchId?: number): string {
  // Ledger 3.9.x uses zcash_protocol 0.10.4, which does not recognize NU7.
  return consensusBranchId === NU7_BRANCH_ID
    ? MIN_LEDGER_NU7_APP_VERSION
    : MIN_LEDGER_ZCASH_APP_VERSION
}

export function assertLedgerZcashAppVersion(version: string, consensusBranchId?: number): void {
  const minimum = minimumLedgerZcashAppVersion(consensusBranchId)
  const actualParts = version.split('.').map(value => Number.parseInt(value, 10) || 0)
  const minimumParts = minimum.split('.').map(Number)
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const delta = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0)
    if (delta > 0) return
    if (delta < 0) {
      throw new Error(
        `Update the Zcash app on your Ledger to ${minimum} or newer in Ledger Wallet, then try again. Connected version: ${version}.`
      )
    }
  }
}
