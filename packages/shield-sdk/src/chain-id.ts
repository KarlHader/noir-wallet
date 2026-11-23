import { ShieldError } from './types'

const CAIP2 = /^([a-z0-9-]{3,8}):([-_a-zA-Z0-9]{1,32})$/
const DECIMAL = /^[1-9]\d*$/
const CANONICAL_HEX = /^0x[0-9a-fA-F]+$/

function invalid(message: string): never {
  throw new ShieldError('INVALID_PARAMS', message)
}

function assertAvailable(chainId: string, available: readonly string[] | undefined): string {
  if (available && !available.includes(chainId)) {
    invalid('Chain ID is not available for Shield in this wallet.')
  }
  return chainId
}

/** Normalize a safe integer, decimal string, eip155:N, or canonical hex to eip155:N. */
export function normalizeEvmChainId(value: unknown): string {
  if (typeof value === 'bigint' || typeof value === 'boolean' || value === null) {
    invalid('EVM chain ID must be a positive safe integer, eip155:N, or canonical hex.')
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      invalid('EVM chain ID must be a positive safe integer.')
    }
    return `eip155:${value}`
  }
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    invalid('EVM chain ID must be a positive safe integer, eip155:N, or canonical hex.')
  }
  if (value.startsWith('eip155:')) {
    const reference = value.slice('eip155:'.length)
    if (!DECIMAL.test(reference)) invalid('EVM chain ID eip155 reference is not a safe integer.')
    const parsed = Number(reference)
    if (!Number.isSafeInteger(parsed) || String(parsed) !== reference) {
      invalid('EVM chain ID is not a safe integer.')
    }
    return `eip155:${parsed}`
  }
  if (CANONICAL_HEX.test(value)) {
    const body = value.slice(2)
    if (body.length > 1 && body.startsWith('0')) {
      invalid('EVM chain ID hex must not contain leading zeros.')
    }
    const parsed = Number.parseInt(body, 16)
    if (
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      body.toLowerCase() !== parsed.toString(16)
    ) {
      invalid('EVM chain ID hex is not a canonical safe integer.')
    }
    return `eip155:${parsed}`
  }
  if (DECIMAL.test(value)) {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
      invalid('EVM chain ID is not a safe integer.')
    }
    return `eip155:${parsed}`
  }
  invalid('EVM chain ID must be a positive safe integer, eip155:N, or canonical hex.')
}

/**
 * EVM values normalize to eip155:N. Any other chain must already be its own CAIP-2.
 * When `available` is provided, the normalized id must be in that set.
 */
export function normalizeShieldChainId(value: unknown, available?: readonly string[]): string {
  if (typeof value === 'number' || (typeof value === 'string' && looksLikeEvmChainId(value))) {
    return assertAvailable(normalizeEvmChainId(value), available)
  }
  if (typeof value !== 'string' || value !== value.trim()) {
    invalid('Chain ID must be an EVM id or a CAIP-2 identifier.')
  }
  const match = CAIP2.exec(value)
  if (!match || match[1] === 'eip155') {
    invalid('Non-EVM chain ID must be its own CAIP-2 identifier.')
  }
  return assertAvailable(value, available)
}

function looksLikeEvmChainId(value: string): boolean {
  return (
    value.startsWith('eip155:') ||
    value.startsWith('0x') ||
    value.startsWith('0X') ||
    DECIMAL.test(value) ||
    value.startsWith('+') ||
    value.startsWith('-') ||
    value.includes('.') ||
    /^[0-9]+[eE]/.test(value)
  )
}
