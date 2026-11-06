import { parseNearAccountId } from './identifiers'

export type NearLendingSupplyReason =
  | 'BurrowCollateral'
  | 'BurrowSupply'
  | 'BurrowRegisterAndCollateral'

export interface NearLendingSupplyBinding {
  readonly tokenContractId: string
  readonly recipientId: string
  readonly customRecipientMsg: string
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string) {
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} has invalid fields`)
  }
}

export function createNearLendingSupplyMessage(input: {
  readonly accountId: string
  readonly reason: NearLendingSupplyReason
  readonly createsMca: boolean
}): string {
  const accountId = parseNearAccountId(input.accountId)
  return JSON.stringify({
    w: [{ Near: accountId }],
    b: { r: input.reason },
    ...(input.createsMca ? { s: [''] } : {})
  })
}

export function parseNearLendingSupplyBinding(
  value: unknown,
  expectedAccountId?: string
): NearLendingSupplyBinding {
  const record = readRecord(value, 'NEAR Lending Supply binding')
  assertExactKeys(
    record,
    ['tokenContractId', 'recipientId', 'customRecipientMsg'],
    'NEAR Lending Supply binding'
  )
  if (typeof record.customRecipientMsg !== 'string' || record.customRecipientMsg.length > 2048) {
    throw new Error('Invalid NEAR Lending Supply message')
  }
  const tokenContractId = parseNearAccountId(record.tokenContractId, 'NEAR token contract')
  const recipientId = parseNearAccountId(record.recipientId, 'NEAR Lending recipient')
  let messageValue: unknown
  try {
    messageValue = JSON.parse(record.customRecipientMsg)
  } catch {
    throw new Error('Invalid NEAR Lending Supply message')
  }
  const message = readRecord(messageValue, 'NEAR Lending Supply message')
  const createsMca = Object.prototype.hasOwnProperty.call(message, 's')
  assertExactKeys(message, createsMca ? ['w', 'b', 's'] : ['w', 'b'], 'NEAR Lending Supply message')
  if (!Array.isArray(message.w) || message.w.length !== 1) {
    throw new Error('Invalid NEAR Lending wallet binding')
  }
  const wallet = readRecord(message.w[0], 'NEAR Lending wallet')
  assertExactKeys(wallet, ['Near'], 'NEAR Lending wallet')
  const accountId = parseNearAccountId(wallet.Near, 'NEAR Lending wallet account')
  const business = readRecord(message.b, 'NEAR Lending business')
  assertExactKeys(business, ['r'], 'NEAR Lending business')
  const allowedReasons = createsMca
    ? ['BurrowRegisterAndCollateral']
    : ['BurrowCollateral', 'BurrowSupply', 'BurrowRegisterAndCollateral']
  if (typeof business.r !== 'string' || !allowedReasons.includes(business.r)) {
    throw new Error('Invalid NEAR Lending Supply reason')
  }
  if (createsMca && (!Array.isArray(message.s) || message.s.length !== 1 || message.s[0] !== '')) {
    throw new Error('Invalid NEAR Lending MCA signature binding')
  }
  if (expectedAccountId !== undefined && accountId !== parseNearAccountId(expectedAccountId)) {
    throw new Error('NEAR Lending wallet does not match the active account')
  }
  const canonicalMessage = createNearLendingSupplyMessage({
    accountId,
    reason: business.r as NearLendingSupplyReason,
    createsMca
  })
  if (canonicalMessage !== record.customRecipientMsg) {
    throw new Error('NEAR Lending Supply message is not canonical')
  }
  return Object.freeze({ tokenContractId, recipientId, customRecipientMsg: canonicalMessage })
}
