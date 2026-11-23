const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) throw new Error(`${label} is invalid`)
}

/**
 * Account storage stake that must remain after a NEAR transaction.
 * This is the reserve already used by native and token transfers:
 * storage usage multiplied by the protocol storage price.
 */
export function nearAccountStorageReserveYocto(
  storageUsage: bigint,
  storageAmountPerByteYocto: bigint
): bigint {
  assertNonNegative(storageUsage, 'NEAR storage usage')
  assertNonNegative(storageAmountPerByteYocto, 'NEAR storage amount per byte')
  const reserve = storageUsage * storageAmountPerByteYocto
  if (reserve > MAXIMUM_U128) throw new Error('NEAR storage reserve exceeds u128')
  return reserve
}

/** Native balance left after the maximum gas fee and the storage reserve. */
export function nearSpendableNativeYocto(input: {
  readonly balanceYocto: bigint
  readonly maximumFeeYocto: bigint
  readonly storageReserveYocto: bigint
}): bigint {
  assertNonNegative(input.balanceYocto, 'NEAR balance')
  assertNonNegative(input.maximumFeeYocto, 'NEAR maximum fee')
  assertNonNegative(input.storageReserveYocto, 'NEAR storage reserve')
  const reserved = input.maximumFeeYocto + input.storageReserveYocto
  if (reserved > MAXIMUM_U128) throw new Error('NEAR reserved balance exceeds u128')
  return input.balanceYocto > reserved ? input.balanceYocto - reserved : 0n
}
