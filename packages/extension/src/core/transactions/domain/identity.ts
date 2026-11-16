declare const transactionIdBrand: unique symbol
declare const transactionSegmentIdBrand: unique symbol
declare const transactionEventIdBrand: unique symbol

export type TransactionId = string & { readonly [transactionIdBrand]: true }
export type TransactionSegmentId = string & { readonly [transactionSegmentIdBrand]: true }
export type TransactionEventId = string & { readonly [transactionEventIdBrand]: true }

function parseIdentifier<T extends string>(value: unknown, label: string): T {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 128
  ) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`)
  }
  return value as T
}

export function parseTransactionId(value: unknown): TransactionId {
  return parseIdentifier<TransactionId>(value, 'TransactionId')
}

export function parseTransactionSegmentId(value: unknown): TransactionSegmentId {
  return parseIdentifier<TransactionSegmentId>(value, 'TransactionSegmentId')
}

export function parseTransactionEventId(value: unknown): TransactionEventId {
  return parseIdentifier<TransactionEventId>(value, 'TransactionEventId')
}
