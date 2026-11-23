import { parseNearAccountId } from './identifiers'

const MAXIMUM_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n
const MAXIMUM_MEMO_LENGTH = 2_048

/** Attached balance wrap.near charges for storage_deposit. Shared with Lending Supply. */
export const NEAR_STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n
/** Gas attached to wrap.near storage_deposit. Shared with Lending Supply. */
export const NEAR_STORAGE_DEPOSIT_GAS = 50_000_000_000_000n
/** Gas attached to wrap.near near_deposit. Shared with Lending Supply. */
export const NEAR_WRAP_DEPOSIT_GAS = 50_000_000_000_000n
/** Gas attached to NEP-141 ft_transfer. Shared with NEAR token transfers. */
export const NEAR_FT_TRANSFER_GAS = 30_000_000_000_000n
/** NEP-141 requires one yoctoNEAR on ft_transfer. Shared with NEAR token transfers. */
export const NEAR_FT_TRANSFER_DEPOSIT_YOCTO = 1n

export const WRAP_NEAR_CONTRACT_ID = 'wrap.near'

export interface BuildNearIntentsDepositActionsInput {
  readonly signerId: string
  readonly depositAddress: string
  readonly amountYocto: bigint
  readonly wrappedBalanceYocto: bigint
  readonly signerRegistered: boolean
  readonly recipientRegistered: boolean
  readonly memo: string
}

export interface NearIntentsDepositAction {
  readonly methodName: 'storage_deposit' | 'near_deposit' | 'ft_transfer'
  readonly args: Readonly<Record<string, unknown>>
  readonly gas: string
  readonly depositYocto: string
}

export interface NearIntentsDepositPlan {
  readonly receiverId: typeof WRAP_NEAR_CONTRACT_ID
  readonly actions: readonly NearIntentsDepositAction[]
  readonly amountYocto: bigint
  readonly wrapAmountYocto: bigint
  readonly storageFeeYocto: bigint
  readonly nativeAttachedYocto: bigint
}

function assertU128(value: bigint, label: string): bigint {
  if (value < 0n || value > MAXIMUM_U128) throw new Error(`${label} exceeds its protocol limit`)
  return value
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
}

function parseMemo(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAXIMUM_MEMO_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('NEAR Intents deposit memo is invalid')
  }
  return value
}

function storageDepositAction(accountId: string): NearIntentsDepositAction {
  return Object.freeze({
    methodName: 'storage_deposit' as const,
    args: Object.freeze({ account_id: accountId, registration_only: true }),
    gas: NEAR_STORAGE_DEPOSIT_GAS.toString(),
    depositYocto: NEAR_STORAGE_DEPOSIT_YOCTO.toString()
  })
}

export function nearIntentsDepositStorageFeeYocto(input: {
  readonly signerRegistered: boolean
  readonly recipientRegistered: boolean
  readonly recipientIsSigner: boolean
}): bigint {
  assertBoolean(input.signerRegistered, 'NEAR signer registration')
  assertBoolean(input.recipientRegistered, 'NEAR recipient registration')
  assertBoolean(input.recipientIsSigner, 'NEAR recipient identity')
  let deposits = 0n
  if (!input.signerRegistered) deposits += 1n
  if (!input.recipientIsSigner && !input.recipientRegistered) deposits += 1n
  return deposits * NEAR_STORAGE_DEPOSIT_YOCTO
}

/**
 * Largest wNEAR amount this deposit can deliver.
 * Spendable native NEAR is the balance after the existing gas and storage reserve.
 * Storage deposits and the 1 yocto ft_transfer deposit are paid from that native balance.
 * Existing wNEAR is added, and near_deposit covers only the shortfall.
 * Returns zero when native NEAR cannot pay the storage deposits required for this transfer.
 */
export function nearIntentsDepositMaximumYocto(input: {
  readonly spendableNativeYocto: bigint
  readonly wrappedBalanceYocto: bigint
  readonly storageDepositFeeYocto: bigint
}): bigint {
  const spendable = assertU128(input.spendableNativeYocto, 'NEAR spendable balance')
  const wrapped = assertU128(input.wrappedBalanceYocto, 'wNEAR balance')
  const storageFee = assertU128(input.storageDepositFeeYocto, 'NEAR storage deposit fee')
  const nativeForWrap = spendable - storageFee - NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  if (nativeForWrap < 0n) return 0n
  return assertU128(nativeForWrap + wrapped, 'NEAR Intents deposit maximum')
}

export function buildNearIntentsDepositActions(
  input: BuildNearIntentsDepositActionsInput
): NearIntentsDepositPlan {
  const signerId = parseNearAccountId(input.signerId, 'NEAR signer account ID')
  const depositAddress = parseNearAccountId(input.depositAddress, 'NEAR Intents deposit address')
  const amount = assertU128(input.amountYocto, 'NEAR Intents deposit amount')
  if (amount === 0n) throw new Error('NEAR Intents deposit amount must be greater than zero')
  const wrapped = assertU128(input.wrappedBalanceYocto, 'wNEAR balance')
  assertBoolean(input.signerRegistered, 'NEAR signer registration')
  assertBoolean(input.recipientRegistered, 'NEAR recipient registration')
  const memo = parseMemo(input.memo)
  const recipientIsSigner = depositAddress === signerId
  const wrapAmount = amount > wrapped ? amount - wrapped : 0n
  const storageFee = nearIntentsDepositStorageFeeYocto({
    signerRegistered: input.signerRegistered,
    recipientRegistered: input.recipientRegistered,
    recipientIsSigner
  })
  const actions: NearIntentsDepositAction[] = []
  if (!input.signerRegistered) actions.push(storageDepositAction(signerId))
  if (wrapAmount > 0n) {
    actions.push(
      Object.freeze({
        methodName: 'near_deposit' as const,
        args: Object.freeze({}),
        gas: NEAR_WRAP_DEPOSIT_GAS.toString(),
        depositYocto: wrapAmount.toString()
      })
    )
  }
  if (!recipientIsSigner && !input.recipientRegistered) {
    actions.push(storageDepositAction(depositAddress))
  }
  actions.push(
    Object.freeze({
      methodName: 'ft_transfer' as const,
      args: Object.freeze({
        receiver_id: depositAddress,
        amount: amount.toString(),
        memo
      }),
      gas: NEAR_FT_TRANSFER_GAS.toString(),
      depositYocto: NEAR_FT_TRANSFER_DEPOSIT_YOCTO.toString()
    })
  )
  const attachedStorage = actions.reduce(
    (total, action) =>
      action.methodName === 'storage_deposit' ? total + BigInt(action.depositYocto) : total,
    0n
  )
  if (attachedStorage !== storageFee) {
    throw new Error('NEAR Intents deposit storage fee does not match its actions')
  }
  return Object.freeze({
    receiverId: WRAP_NEAR_CONTRACT_ID,
    actions: Object.freeze(actions),
    amountYocto: amount,
    wrapAmountYocto: wrapAmount,
    storageFeeYocto: storageFee,
    nativeAttachedYocto: wrapAmount + storageFee + NEAR_FT_TRANSFER_DEPOSIT_YOCTO
  })
}
