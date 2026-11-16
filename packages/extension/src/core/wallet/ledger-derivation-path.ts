export type LedgerDerivationMode = 'ledger-live' | 'standard' | 'legacy' | 'root' | 'noir'
export type LedgerEvmDerivationMode = Extract<
  LedgerDerivationMode,
  'ledger-live' | 'standard' | 'legacy'
>
export type LedgerSolanaDerivationMode = Extract<
  LedgerDerivationMode,
  'standard' | 'legacy' | 'root'
>
export type LedgerNearDerivationMode = Extract<LedgerDerivationMode, 'standard' | 'noir'>

const MAX_INDEX = 0x7fffffff

function index(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INDEX) {
    throw new Error('Invalid Ledger derivation index')
  }
  return value
}

function components(path: string, family: string): string[] {
  if (typeof path !== 'string' || path.length > 128 || !path.startsWith('m/')) {
    throw new Error(`Invalid Ledger ${family} derivation path`)
  }
  const parts = path.slice(2).split('/')
  if (
    parts.some(part => {
      const match = /^(0|[1-9][0-9]*)('?)$/.exec(part)
      return !match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) > MAX_INDEX
    })
  ) {
    throw new Error(`Non-canonical Ledger ${family} derivation path`)
  }
  return parts
}

export function ledgerEvmDerivationPath(
  mode: LedgerEvmDerivationMode,
  accountIndex: number
): string {
  const i = index(accountIndex)
  switch (mode) {
    case 'ledger-live':
      return `m/44'/60'/${i}'/0/0`
    case 'standard':
      return `m/44'/60'/0'/0/${i}`
    case 'legacy':
      return `m/44'/60'/0'/${i}`
  }
}

export function ledgerSolanaDerivationPath(
  mode: LedgerSolanaDerivationMode,
  accountIndex: number
): string {
  const i = index(accountIndex)
  switch (mode) {
    case 'standard':
      return `m/44'/501'/${i}'/0'`
    case 'legacy':
      return `m/44'/501'/${i}'`
    case 'root':
      if (i !== 0) throw new Error('Ledger Solana root path has no account index')
      return "m/44'/501'"
  }
}

export function ledgerNearDerivationPath(
  mode: LedgerNearDerivationMode,
  accountIndex: number
): string {
  const i = index(accountIndex)
  switch (mode) {
    case 'standard':
      return `m/44'/397'/0'/0'/${i}'`
    case 'noir':
      return `m/44'/397'/${i}'/0'/1'`
  }
}

export function validateLedgerEvmDerivationPath(path: string): string {
  const parts = components(path, 'EVM')
  if (
    parts[0] !== "44'" ||
    parts[1] !== "60'" ||
    !(
      (parts.length === 5 &&
        /^\d+'$/.test(parts[2]) &&
        parts[3] === '0' &&
        /^\d+$/.test(parts[4])) ||
      (parts.length === 4 && parts[2] === "0'" && /^\d+$/.test(parts[3]))
    )
  ) {
    throw new Error('Unsupported Ledger EVM derivation path')
  }
  return path
}

export function validateLedgerSolanaDerivationPath(path: string): string {
  const parts = components(path, 'Solana')
  if (
    parts[0] !== "44'" ||
    parts[1] !== "501'" ||
    parts.length < 2 ||
    parts.length > 5 ||
    parts.some(part => !part.endsWith("'"))
  ) {
    throw new Error('Invalid Ledger Solana derivation path')
  }
  return path
}

export function validateLedgerNearDerivationPath(path: string): string {
  const parts = components(path, 'NEAR')
  if (
    parts.length !== 5 ||
    parts[0] !== "44'" ||
    parts[1] !== "397'" ||
    parts.some(part => !part.endsWith("'"))
  ) {
    throw new Error('Invalid Ledger NEAR derivation path')
  }
  return path
}
