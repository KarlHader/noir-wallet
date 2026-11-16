import { hashTypedData } from 'viem'
import type {
  EvmTypedDataSummary,
  EvmTypedDataValue
} from '../../../core/keyring/domain/signing-summary'

const PERMIT2_ADDRESS = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/

export interface EvmPermitReview {
  readonly protocol: 'Permit' | 'Permit2'
  readonly kind: 'allowance' | 'transfer'
  readonly owner: string
  readonly spender: string
  readonly verifyingContract: string
  readonly signatureDeadlineRaw: string
  readonly tokens: readonly {
    readonly contractAddress: string
    readonly amountRaw: string
    readonly amountBits: 160 | 256
    readonly expirationRaw?: string
  }[]
}

function fields(
  value: EvmTypedDataValue,
  typeName: string,
  names: readonly string[]
): readonly EvmTypedDataValue[] | null {
  if (
    value.kind !== 'struct' ||
    value.typeName !== typeName ||
    value.fields.length !== names.length ||
    value.fields.some((field, index) => field.name !== names[index])
  ) {
    return null
  }
  return value.fields.map(field => field.value)
}

function address(value: EvmTypedDataValue): string | null {
  return value.kind === 'scalar' && value.solidityType === 'address' && ADDRESS.test(value.value)
    ? value.value
    : null
}

function unsigned(value: EvmTypedDataValue, bits: 48 | 160 | 256): string | null {
  if (
    value.kind !== 'scalar' ||
    value.solidityType !== `uint${bits}` ||
    !DECIMAL.test(value.value) ||
    value.value.length > 78
  ) {
    return null
  }
  return BigInt(value.value) < 1n << BigInt(bits) ? value.value : null
}

function domain(summary: EvmTypedDataSummary): string | null {
  const { domain } = summary.fields
  if (domain.kind !== 'struct' || domain.typeName !== 'EIP712Domain') return null

  const permit2 = summary.fields.primaryType !== 'Permit'
  const expected = permit2
    ? ['name', 'chainId', 'verifyingContract']
    : ['name', 'version', 'chainId', 'verifyingContract', 'salt']
  const names = domain.fields.map(field => field.name)
  if (
    new Set(names).size !== names.length ||
    names.some(name => !expected.includes(name)) ||
    names.join('|') !== expected.filter(name => names.includes(name)).join('|') ||
    !names.includes('chainId') ||
    !names.includes('verifyingContract') ||
    (permit2 && names.join('|') !== expected.join('|'))
  ) {
    return null
  }
  const values = new Map(domain.fields.map(field => [field.name, field.value]))
  const chainId = values.get('chainId')
  const verifyingContract = values.get('verifyingContract')
  const signedChainId = chainId ? unsigned(chainId, 256) : null
  if (
    !verifyingContract ||
    signedChainId === null ||
    summary.chainId !== `eip155:${signedChainId}`
  ) {
    return null
  }
  const contract = address(verifyingContract)
  if (!contract) return null

  for (const key of ['name', 'version'] as const) {
    const value = values.get(key)
    if (value && (value.kind !== 'scalar' || value.solidityType !== 'string')) return null
  }
  const salt = values.get('salt')
  if (
    salt &&
    (salt.kind !== 'scalar' ||
      salt.solidityType !== 'bytes32' ||
      !/^0x[0-9a-fA-F]{64}$/.test(salt.value))
  ) {
    return null
  }
  if (permit2) {
    const name = values.get('name')
    if (name?.kind !== 'scalar' || name.value !== 'Permit2') return null
    if (contract.toLowerCase() !== PERMIT2_ADDRESS) return null
  } else if (contract.toLowerCase() === PERMIT2_ADDRESS) {
    return null
  }
  return contract
}

function permitDetails(value: EvmTypedDataValue): EvmPermitReview['tokens'][number] | null {
  const detail = fields(value, 'PermitDetails', ['token', 'amount', 'expiration', 'nonce'])
  if (!detail) return null
  const contractAddress = address(detail[0])
  const amountRaw = unsigned(detail[1], 160)
  const expirationRaw = unsigned(detail[2], 48)
  if (
    !contractAddress ||
    amountRaw === null ||
    expirationRaw === null ||
    unsigned(detail[3], 48) === null
  ) {
    return null
  }
  return { contractAddress, amountRaw, amountBits: 160, expirationRaw }
}

function tokenPermission(value: EvmTypedDataValue): EvmPermitReview['tokens'][number] | null {
  const permission = fields(value, 'TokenPermissions', ['token', 'amount'])
  if (!permission) return null
  const contractAddress = address(permission[0])
  const amountRaw = unsigned(permission[1], 256)
  return contractAddress && amountRaw !== null
    ? { contractAddress, amountRaw, amountBits: 256 }
    : null
}

function tokenList(
  value: EvmTypedDataValue,
  itemType: 'PermitDetails' | 'TokenPermissions',
  decode: (value: EvmTypedDataValue) => EvmPermitReview['tokens'][number] | null
): EvmPermitReview['tokens'] | null {
  if (value.kind !== 'array' || value.itemType !== itemType || value.items.length === 0) return null
  const tokens = value.items.map(decode)
  return tokens.every((token): token is EvmPermitReview['tokens'][number] => token !== null)
    ? tokens
    : null
}

function plainTypedValue(value: EvmTypedDataValue): unknown {
  if (value.kind === 'scalar') {
    return /^uint[0-9]+$/.test(value.solidityType) ? BigInt(value.value) : value.value
  }
  if (value.kind === 'array') return value.items.map(plainTypedValue)
  return Object.fromEntries(value.fields.map(field => [field.name, plainTypedValue(field.value)]))
}

function matchesCanonicalBatchDigest(summary: EvmTypedDataSummary): boolean {
  const primaryType = summary.fields.primaryType
  try {
    const typedData = {
      domain: plainTypedValue(summary.fields.domain),
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' }
        ],
        ...(primaryType === 'PermitBatch'
          ? {
              PermitDetails: [
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint160' },
                { name: 'expiration', type: 'uint48' },
                { name: 'nonce', type: 'uint48' }
              ],
              PermitBatch: [
                { name: 'details', type: 'PermitDetails[]' },
                { name: 'spender', type: 'address' },
                { name: 'sigDeadline', type: 'uint256' }
              ]
            }
          : {
              TokenPermissions: [
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint256' }
              ],
              PermitBatchTransferFrom: [
                { name: 'permitted', type: 'TokenPermissions[]' },
                { name: 'spender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' }
              ]
            })
      },
      primaryType,
      message: plainTypedValue(summary.fields.message)
    }
    return (
      hashTypedData(typedData as Parameters<typeof hashTypedData>[0]).toLowerCase() ===
      summary.fields.digestHex.toLowerCase()
    )
  } catch {
    return false
  }
}

export function decodeEvmPermitReview(summary: EvmTypedDataSummary): EvmPermitReview | null {
  if (summary.schema !== 'evm.typed-data.v1' || summary.operation !== 'message') return null
  const owner = summary.fields.signer
  if (!ADDRESS.test(owner)) return null
  const verifyingContract = domain(summary)
  if (!verifyingContract) return null
  const message = summary.fields.message
  const primaryType = summary.fields.primaryType
  if (message.kind !== 'struct' || message.typeName !== primaryType) return null

  if (primaryType === 'Permit') {
    const permit = fields(message, 'Permit', ['owner', 'spender', 'value', 'nonce', 'deadline'])
    if (!permit) return null
    const signedOwner = address(permit[0])
    const spender = address(permit[1])
    const amountRaw = unsigned(permit[2], 256)
    const nonce = unsigned(permit[3], 256)
    const signatureDeadlineRaw = unsigned(permit[4], 256)
    if (
      !signedOwner ||
      signedOwner.toLowerCase() !== owner.toLowerCase() ||
      !spender ||
      amountRaw === null ||
      nonce === null ||
      signatureDeadlineRaw === null
    ) {
      return null
    }
    return {
      protocol: 'Permit',
      kind: 'allowance',
      owner,
      spender,
      verifyingContract,
      signatureDeadlineRaw,
      tokens: [{ contractAddress: verifyingContract, amountRaw, amountBits: 256 }]
    }
  }

  const allowance = primaryType === 'PermitSingle' || primaryType === 'PermitBatch'
  const transfer = primaryType === 'PermitTransferFrom' || primaryType === 'PermitBatchTransferFrom'
  if (!allowance && !transfer) return null
  const single = primaryType === 'PermitSingle' || primaryType === 'PermitTransferFrom'
  const signed = fields(
    message,
    primaryType,
    allowance
      ? ['details', 'spender', 'sigDeadline']
      : ['permitted', 'spender', 'nonce', 'deadline']
  )
  if (!signed) return null
  const spender = address(signed[1])
  const signatureDeadlineRaw = unsigned(signed[allowance ? 2 : 3], 256)
  if (
    !spender ||
    signatureDeadlineRaw === null ||
    (transfer && unsigned(signed[2], 256) === null)
  ) {
    return null
  }
  const token = single ? (allowance ? permitDetails(signed[0]) : tokenPermission(signed[0])) : null
  const tokens = single
    ? token && [token]
    : allowance
      ? tokenList(signed[0], 'PermitDetails', permitDetails)
      : tokenList(signed[0], 'TokenPermissions', tokenPermission)
  if (!tokens) return null
  // The summary AST drops fixed array lengths, so confirm the original digest used dynamic arrays.
  if (!single && !matchesCanonicalBatchDigest(summary)) return null
  return {
    protocol: 'Permit2',
    kind: allowance ? 'allowance' : 'transfer',
    owner,
    spender,
    verifyingContract,
    signatureDeadlineRaw,
    tokens
  }
}
