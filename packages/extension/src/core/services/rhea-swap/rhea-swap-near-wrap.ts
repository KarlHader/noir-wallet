import type { RheaSwapToken } from './rhea-swap-model'

const WRAP_NEAR = 'wrap.near'
const WRAP_PROTOCOL_ASSET_ID = 'nep141:wrap.near'
const NEAR_TOKEN_LIST_CHAIN_ID = 900001
const WRAP_GAS = '50000000000000'
const FT_TRANSFER_DEPOSIT = '1'
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
  // Native NEAR wraps its shortfall. A valid wNEAR quote spends wNEAR and does not wrap.
  return native
}

/**
 * From-quote view of wrap.near. It shares wNEAR's chain address, so callers must
 * apply it after catalog parsing and must not write the result back to the cache.
 */
export function withNearNativeCatalogToken(
  tokens: readonly RheaSwapToken[]
): readonly RheaSwapToken[] {
  if (tokens.some(token => token.rheaChainId === 'near' && token.isNative)) return tokens
  const index = tokens.findIndex(
    token =>
      token.rheaChainId === 'near' &&
      token.tokenListChainId === NEAR_TOKEN_LIST_CHAIN_ID &&
      token.assetId === WRAP_PROTOCOL_ASSET_ID &&
      token.rheaAddress === WRAP_NEAR &&
      token.decimals === 24 &&
      token.isNative === false
  )
  const wrapped = index < 0 ? undefined : tokens[index]
  if (!wrapped) return tokens
  const native = Object.freeze({
    ...wrapped,
    isNative: true,
    contractAddress: null,
    symbol: 'NEAR'
  })
  return [...tokens.slice(0, index), native, ...tokens.slice(index)]
}

function isFunctionArgs(
  args: Readonly<Record<string, unknown>> | readonly number[]
): args is Readonly<Record<string, unknown>> {
  return !Array.isArray(args)
}

function transferAmount(action: NearAction): bigint {
  if (action.type !== 'functionCall') return 0n
  if (action.methodName !== 'ft_transfer' && action.methodName !== 'ft_transfer_call') return 0n
  if (!isFunctionArgs(action.args) || typeof action.args.amount !== 'string') {
    throw new Error('RHEA Swap NEAR wNEAR transfer amount is invalid')
  }
  return unsigned(action.args.amount, 'wNEAR transfer amount')
}

/**
 * wNEAR spends the fungible balance. Drop native funding from the provider batch and
 * keep the NEP-141 attached deposit at one yoctoNEAR.
 */
export function spendRheaSwapWrappedNear(transactions: readonly NearWrapTransaction[]): Readonly<{
  transactions: readonly NearWrapTransaction[]
  amountRaw: bigint
}> {
  let amountRaw = 0n
  const next = transactions.flatMap(transaction => {
    const actions = transaction.actions.flatMap(action => {
      if (action.type === 'transfer') return []
      if (action.methodName === 'near_deposit') return []
      amountRaw += transferAmount(action)
      if (
        action.type === 'functionCall' &&
        (action.methodName === 'ft_transfer' || action.methodName === 'ft_transfer_call') &&
        action.deposit !== FT_TRANSFER_DEPOSIT
      ) {
        return [Object.freeze({ ...action, deposit: FT_TRANSFER_DEPOSIT })]
      }
      return [action]
    })
    if (actions.length === 0) return []
    return [Object.freeze({ ...transaction, actions: Object.freeze(actions) })]
  })
  if (next.length === 0 || next.length > 16) {
    throw new Error('RHEA Swap NEAR wNEAR transfer is missing')
  }
  return Object.freeze({
    transactions: Object.freeze(next),
    amountRaw
  })
}

export interface NearSwapActionCost {
  readonly executionGas: string
  readonly sendNotSirGas: string
  readonly sendSirGas: string
}

export interface NearSwapNativeCostConfig {
  readonly actionReceiptCreation: NearSwapActionCost
  readonly transfer: NearSwapActionCost
  readonly functionCall: NearSwapActionCost
  readonly functionCallPerByte: NearSwapActionCost
}

function actionGas(cost: NearSwapActionCost, senderIsReceiver: boolean, label: string): bigint {
  return (
    unsigned(senderIsReceiver ? cost.sendSirGas : cost.sendNotSirGas, `${label} send gas`) +
    unsigned(cost.executionGas, `${label} execution gas`)
  )
}

function functionCallBytes(action: Extract<NearAction, { type: 'functionCall' }>): bigint {
  const argsBytes = Array.isArray(action.args)
    ? action.args.length
    : new TextEncoder().encode(JSON.stringify(action.args)).length
  return BigInt(new TextEncoder().encode(action.methodName).length + argsBytes)
}

/**
 * Native NEAR required to submit the whole batch. Prepaid gas and protocol send
 * and execution fees use the price the caller selects, which must already be the
 * higher of the block gas price and the minimum gas purchase price.
 */
export function nearSwapNativeRequiredYocto(
  transactions: readonly NearWrapTransaction[],
  gasPriceYocto: bigint,
  signerId: string,
  costs: NearSwapNativeCostConfig
): bigint {
  if (gasPriceYocto < 0n) throw new Error('RHEA Swap NEAR gas price is invalid')
  let required = 0n
  for (const transaction of transactions) {
    const senderIsReceiver = signerId === transaction.receiverId
    required += actionGas(costs.actionReceiptCreation, senderIsReceiver, 'receipt') * gasPriceYocto
    for (const action of transaction.actions) {
      required += unsigned(action.deposit, 'attached deposit')
      if (action.type === 'transfer') {
        required += actionGas(costs.transfer, senderIsReceiver, 'transfer') * gasPriceYocto
        continue
      }
      const bytes = functionCallBytes(action)
      required += actionGas(costs.functionCall, senderIsReceiver, 'function call') * gasPriceYocto
      required +=
        actionGas(costs.functionCallPerByte, senderIsReceiver, 'function call byte') *
        bytes *
        gasPriceYocto
      required += unsigned(action.gas, 'gas') * gasPriceYocto
    }
  }
  return required
}

/**
 * Native yocto that must stay outside amountIn. Covers the quote's attached
 * deposits, first wrap.near registration, prepaid gas, and the account storage
 * stake. Existing wNEAR is not spent; the full amount is wrapped from native NEAR.
 */
export function nearDirectNativeHoldYocto(
  input: Readonly<{
    transactions: readonly NearWrapTransaction[]
    amountIn: string
    registered: boolean
    gasPriceYocto: bigint
    signerId: string
    costs: NearSwapNativeCostConfig
    storageReserveYocto: bigint
  }>
): bigint {
  if (input.storageReserveYocto < 0n) throw new Error('RHEA Swap NEAR storage reserve is invalid')
  const amount = unsigned(input.amountIn, 'source amount')
  const batch = prependRheaSwapNearWrap({
    transactions: input.transactions,
    amountIn: input.amountIn,
    wrappedBalanceRaw: '0',
    registered: input.registered
  })
  const required = nearSwapNativeRequiredYocto(
    batch,
    input.gasPriceYocto,
    input.signerId,
    input.costs
  )
  const hold = required - amount + input.storageReserveYocto
  if (hold < 0n) throw new Error('RHEA Swap NEAR native hold is invalid')
  return hold
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
