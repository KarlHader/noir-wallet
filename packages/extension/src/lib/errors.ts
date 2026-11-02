/**
 * Centralized error classification and user-friendly message mapping.
 *
 * Raw errors from WASM/gRPC/Worker are matched against patterns and
 * converted to actionable messages the user can understand.
 */
import { isWalletSnapshotIntegrityError } from './wallet-snapshot-errors'

export const WALLET_SNAPSHOT_RECOVERY_MESSAGE =
  'Wallet data needs to be resynced before sending again.'

export function getResponseErrorMessage(response: unknown): string | undefined {
  if (
    typeof response !== 'object' ||
    response === null ||
    Array.isArray(response) ||
    !('error' in response)
  )
    return undefined
  return typeof response.error === 'string' ? response.error : undefined
}

export function isWalletSnapshotRecoveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const prefix = `${WALLET_SNAPSHOT_RECOVERY_MESSAGE}\n\nOriginal error: `
  return isWalletSnapshotIntegrityError(
    message.startsWith(prefix) ? message.slice(prefix.length) : message
  )
}

interface ErrorMapping {
  pattern: RegExp
  message: string
  retryable: boolean
}

const RPC_ENDPOINT_ERROR_PATTERN =
  /gRPC|grpc|StatusCode::|UNAVAILABLE|transport error|connect error|deadline exceeded|fetch.*failed|network.*error|ERR_NETWORK|net::ERR_|ECONNREFUSED|ENOTFOUND|ECONNRESET|rate.?limit|InvalidContentType|invalid content type|MalformedResponse|malformed response|Failed to resolve chain height from network|HTTP\s+(?:408|425|429|5\d{2})\b/i
const LOCAL_WALLET_RPC_ERROR_PATTERN =
  /Offscreen RPC|Worker RPC|Worker crashed|Worker not initialized|SYNC_BUSY|STALE_WALLET_RPC|WALLET_DIRTY/i
const WALLET_LOCKED_ERROR_PATTERN = /Wallet is locked|Wallet not unlocked|Wallet locked/i

export function isWalletLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return WALLET_LOCKED_ERROR_PATTERN.test(message)
}

export function isRpcEndpointError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (LOCAL_WALLET_RPC_ERROR_PATTERN.test(message)) return false
  return RPC_ENDPOINT_ERROR_PATTERN.test(message) || /\b(?:request )?timed? ?out\b/i.test(message)
}

const ERROR_MAPPINGS: ErrorMapping[] = [
  // --- Network / gRPC ---
  {
    pattern: /gRPC|grpc|StatusCode::|UNAVAILABLE|transport error|connect error/i,
    message: 'Network connection failed. Please check your internet and try again.',
    retryable: true
  },
  {
    pattern: /timeout|timed out|deadline exceeded/i,
    message: 'Request timed out.',
    retryable: true
  },
  {
    pattern: /fetch.*failed|network.*error|ERR_NETWORK|net::ERR_/i,
    message: 'Network error. Please check your internet connection.',
    retryable: true
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|ECONNRESET/i,
    message: 'Could not reach the server. Please try again later.',
    retryable: true
  },
  {
    pattern: /rate.?limit|\bHTTP\s+429\b/i,
    message: 'Server is busy. Please wait a moment and try again.',
    retryable: true
  },
  {
    pattern: /HTTP\s+5\d{2}\b/i,
    message: 'Service is temporarily unavailable. Please try again shortly.',
    retryable: true
  },
  {
    pattern: /EVM transaction failed simulation/i,
    message: 'The transaction failed simulation. Check the transaction details and try again.',
    retryable: false
  },

  // --- Swap routing ---
  {
    pattern: /RHEA Swap quote expired/i,
    message: 'Swap quote expired. Get a new quote and review it again.',
    retryable: false
  },
  {
    pattern: /minimum (?:swap )?amount|amount.*(?:below|less than).*minimum/i,
    message: 'Amount is below the current minimum for this Swap route.',
    retryable: false
  },
  {
    pattern: /no liquidity|no (?:swap )?route|route not found|failed to find.*route/i,
    message: 'No Swap route is available for this asset pair.',
    retryable: false
  },
  {
    pattern:
      /token .*not found on chain|token .*not supported by 1click|unsupported (?:destination )?token/i,
    message: 'This asset is not supported for this Swap route.',
    retryable: false
  },
  {
    pattern: /1click upstream|swap provider.*unavailable|quote endpoint.*unavailable/i,
    message: 'The Swap provider is temporarily unavailable. Please try again later.',
    retryable: true
  },

  // --- WASM / Worker ---
  {
    pattern: /Worker crashed|Worker not initialized/i,
    message: 'Wallet engine error. Please restart the extension.',
    retryable: false
  },
  {
    pattern: /Offscreen RPC timeout|Worker RPC timeout/i,
    message: 'Operation timed out. Please try again.',
    retryable: true
  },
  {
    pattern: /Offscreen RPC failed after/i,
    message: 'Wallet engine is not responding. Please restart the extension.',
    retryable: false
  },
  {
    pattern: /WASM.*panic|HEALTH_CHECK_TIMEOUT/i,
    message: 'Wallet engine crashed. Please restart the extension.',
    retryable: false
  },
  {
    pattern: /Web Worker is not supported/i,
    message: 'Your browser does not support this feature.',
    retryable: false
  },
  {
    pattern: /SYNC_BUSY|wallet sync in progress|wallet reload in progress/i,
    message: 'Wallet is syncing. Please try again after sync completes.',
    retryable: true
  },
  {
    pattern: /STALE_WALLET_RPC/i,
    message: 'Wallet state changed. Please retry the operation.',
    retryable: true
  },

  // --- Authentication / Account ---
  {
    pattern: /^Backup words do not match this wallet\./i,
    message: 'Backup words do not match this wallet. View your secret phrase and try again.',
    retryable: false
  },
  {
    pattern: /^Unable to verify this wallet backup\./i,
    message: "Unlock and view this wallet's secret phrase before verifying its backup.",
    retryable: false
  },
  {
    pattern: /^Wallet changed or (?:was removed|locked)\. Please try again\./i,
    message: 'Wallet state changed. Please retry the operation.',
    retryable: true
  },
  {
    pattern: /Incorrect password|Current password is incorrect/i,
    message: 'Incorrect password. Please try again.',
    retryable: false
  },
  {
    pattern: /Invalid password/i,
    message: 'Invalid password. Please try again.',
    retryable: false
  },
  {
    pattern: /Invalid (?:seed|recovery) phrase/i,
    message: 'Invalid recovery phrase. Please check and try again.',
    retryable: false
  },
  {
    pattern: /Account key mismatch/i,
    message: 'Account data conflict. Please re-import your wallet.',
    retryable: false
  },
  {
    pattern: WALLET_LOCKED_ERROR_PATTERN,
    message: 'Wallet is locked. Please unlock and try again.',
    retryable: false
  },
  {
    pattern: /Zcash wallet runtime not initialized|Wallet not initialized/i,
    message: 'Wallet is initializing. Please wait a moment and try again.',
    retryable: true
  },
  {
    pattern: /Account not initialized|Account not ready/i,
    message: 'Account is loading. Please wait a moment and try again.',
    retryable: true
  },
  {
    pattern: /Account initialization timeout/i,
    message: 'Account initialization timed out. Please restart and try again.',
    retryable: false
  },
  {
    pattern: /Password not set/i,
    message: 'No password set. Please set up your wallet first.',
    retryable: false
  },
  {
    pattern: /Wallet not found|No wallet data found/i,
    message: 'Wallet not found. Please create or import a wallet.',
    retryable: false
  },
  {
    pattern: /Account not found|No account selected|No account available|No active account/i,
    message: 'No account available. Please select or create an account.',
    retryable: false
  },
  {
    pattern: /Could not load seed phrase|Failed to load wallet credential/i,
    message: 'Failed to load wallet data. Please try unlocking again.',
    retryable: false
  },
  {
    pattern: /Cannot remove the last account/i,
    message: 'Cannot remove the last account. Each wallet needs at least one account.',
    retryable: false
  },
  {
    pattern: /Too many failed attempts/i,
    message: 'Too many failed attempts. Account temporarily locked.',
    retryable: false
  },

  // --- Transaction ---
  {
    pattern:
      /The EVM balance (?:is insufficient|does not cover the transfer and network fee)|(?:EVM account|Private Execution Address) needs \d+ more wei for transaction value and maximum Gas/i,
    message: 'Insufficient native balance for the amount and network fee.',
    retryable: false
  },
  {
    pattern: /InsufficientFunds|insufficient.*(?:balance|fund)|not enough.*fund/i,
    message: 'Insufficient balance for this transaction.',
    retryable: false
  },
  {
    pattern: /dust.*threshold/i,
    message: 'Amount is too small to send.',
    retryable: false
  },
  {
    pattern: /invalid.*address/i,
    message: 'Invalid recipient address. Please check and try again.',
    retryable: false
  },
  {
    pattern: /No transparent funds available to shield/i,
    message: 'No transparent funds available to shield.',
    retryable: false
  },
  {
    pattern: /Transaction timed out/i,
    message: 'Transaction timed out. Please check your transaction history and try again.',
    retryable: false
  },
  {
    pattern: /Failed to create transaction/i,
    message: 'Failed to create transaction. Please try again.',
    retryable: true
  },

  // --- dApp / SDK ---
  {
    pattern: /Invalid params/i,
    message: 'Invalid request parameters from the dApp.',
    retryable: false
  },
  {
    pattern: /Not authorized.*requestAccounts/i,
    message: 'Not authorized. Please connect the dApp first.',
    retryable: false
  },
  {
    pattern: /No connection found/i,
    message: 'No active connection. Please reconnect the dApp.',
    retryable: false
  },
  {
    pattern: /zcash_switchNetwork is deprecated/i,
    message: 'Network switching is deprecated. Install the testnet extension instead.',
    retryable: false
  },
  {
    pattern: /Unknown method/i,
    message: 'Unsupported operation requested.',
    retryable: false
  },

  // --- Hardware Wallet ---
  {
    pattern: /Watch-only wallet.*hardware signing/i,
    message: 'This operation requires hardware wallet signing.',
    retryable: false
  },
  {
    pattern: /signing is not supported by hardware/i,
    message: 'This operation is not supported by hardware wallets.',
    retryable: false
  },
  {
    pattern: /Wallet must be unlocked to add a hardware wallet/i,
    message: 'Please unlock your wallet before adding a hardware wallet.',
    retryable: false
  },
  {
    pattern: /QR code contains no Zcash accounts/i,
    message: 'No Zcash accounts found in the QR code.',
    retryable: false
  },
  {
    pattern: /Unrecognized QR code|Unexpected QR content/i,
    message: 'Unrecognized QR code format. Please scan a valid Zcash QR code.',
    retryable: false
  },

  // --- User Action ---
  {
    pattern: /User rejected|User denied|cancelled/i,
    message: 'Request cancelled by user.',
    retryable: false
  },

  // --- Persist / Storage ---
  {
    pattern: /persist timeout/i,
    message: 'Failed to save wallet data. Please try again.',
    retryable: true
  },

  // --- ZNS ---
  {
    pattern: /Name not found/i,
    message: 'ZNS name not found.',
    retryable: false
  },
  {
    pattern: /Resolution failed/i,
    message: 'ZNS name resolution failed. Please try again.',
    retryable: true
  }
]

export interface ClassifiedError {
  userMessage: string
  technicalMessage: string
  retryable: boolean
}

export function classifyError(error: unknown): ClassifiedError {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)

  if (isWalletSnapshotRecoveryError(error)) {
    return {
      userMessage: WALLET_SNAPSHOT_RECOVERY_MESSAGE,
      technicalMessage: raw,
      retryable: false
    }
  }

  for (const mapping of ERROR_MAPPINGS) {
    if (mapping.pattern.test(raw)) {
      return {
        userMessage: mapping.message,
        technicalMessage: raw,
        retryable: mapping.retryable
      }
    }
  }

  return {
    userMessage: 'An unexpected error occurred. Please try again.',
    technicalMessage: raw,
    retryable: true
  }
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries when the error is classified as retryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, label = 'operation' } = options

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const classified = classifyError(err)
      if (!classified.retryable || attempt === maxAttempts) {
        throw new Error(classified.userMessage)
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1)
      console.warn(
        `[Retry] ${label} attempt ${attempt}/${maxAttempts} failed: ${classified.technicalMessage}. Retrying in ${delay}ms...`
      )
      await new Promise(r => setTimeout(r, delay))
    }
  }

  throw lastError
}
