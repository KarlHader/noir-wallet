const WRAP_NEAR = 'wrap.near'
const WRAP_GAS = '50000000000000'
const STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n
type NearAction =
  | Readonly<{ type: 'transfer'; deposit: string }>
  | Readonly<{
      type: 'functionCall'
      methodName: string
      args: Readonly<Record<string, unknown>> | readonly number[]
      gas: string
      deposit: string
    }>

export type NearWrapTransaction = Readonly<{
  receiverId: string
  actions: readonly NearAction[]
  signerId?: string
}>

function unsigned(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`RHEA Swap NEAR ${label} is invalid`)
  }
  return BigInt(value)
}

export function isNearWrapSwapSource(
  chainId: string,
  assetId: string,
  protocolAssetId: string,
  tokenIn: string
): boolean {
  if (chainId !== 'near:mainnet') return false
  const native = assetId === 'near:mainnet/slip44:397'
  const wrapped = assetId === 'near:mainnet/nep141:wrap.near'
  const wrapAddresses = ['wrap.near', 'nep141:wrap.near', 'near:mainnet/nep141:wrap.near']
  if (!native && !wrapped) {
    if (wrapAddresses.includes(tokenIn)) {
      throw new Error('RHEA Swap NEAR quote source does not match its asset')
    }
    return false
  }
  if (
    (native && protocolAssetId !== 'native' && protocolAssetId !== 'nep141:wrap.near') ||
    (wrapped && protocolAssetId !== 'nep141:wrap.near') ||
    ![...(native ? ['native', 'near'] : []), ...wrapAddresses].includes(tokenIn)
  ) {
    throw new Error('RHEA Swap NEAR quote source does not match its asset')
  }
  return true
}

export function prependRheaSwapNearWrap(
  input: Readonly<{
    transactions: readonly NearWrapTransaction[]
    amountIn: string
    wrappedBalanceRaw: string
    registered: boolean
  }>
): readonly NearWrapTransaction[] {
  const amount = unsigned(input.amountIn, 'source amount')
  const balance = unsigned(input.wrappedBalanceRaw, 'wrapped balance')
  if (amount === 0n) throw new Error('RHEA Swap NEAR source amount is invalid')
  const shortfall = amount > balance ? amount - balance : 0n
  const required = shortfall + (input.registered ? 0n : STORAGE_DEPOSIT_YOCTO)

  let existingDeposit: bigint | null = null
  for (const [index, transaction] of input.transactions.entries()) {
    for (const action of transaction.actions) {
      if (action.type !== 'functionCall' || action.methodName !== 'near_deposit') continue
      if (
        existingDeposit !== null ||
        index !== 0 ||
        transaction.receiverId !== WRAP_NEAR ||
        transaction.actions.length !== 1 ||
        Array.isArray(action.args) ||
        Object.keys(action.args).length !== 0 ||
        !/^[1-9][0-9]*$/.test(action.gas) ||
        BigInt(action.gas) < BigInt(WRAP_GAS) ||
        !/^[1-9][0-9]*$/.test(action.deposit)
      ) {
        throw new Error('RHEA Swap NEAR existing wrap action is invalid')
      }
      existingDeposit = BigInt(action.deposit)
    }
  }
  if (existingDeposit !== null) {
    if (existingDeposit < required) {
      throw new Error('RHEA Swap NEAR existing wrap deposit is insufficient')
    }
    return input.transactions
  }
  if (required === 0n) return input.transactions
  if (input.transactions.length >= 16) {
    throw new Error('RHEA Swap NEAR batch has no room for the wrap transaction')
  }
  return Object.freeze([
    Object.freeze({
      receiverId: WRAP_NEAR,
      actions: Object.freeze([
        Object.freeze({
          type: 'functionCall' as const,
          methodName: 'near_deposit',
          args: Object.freeze({}),
          gas: WRAP_GAS,
          deposit: required.toString()
        })
      ])
    }),
    ...input.transactions
  ])
}
