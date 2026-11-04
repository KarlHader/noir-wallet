import type { PublicAsset, PublicFunctionCallRequest } from '@noir-wallet/sdk'

export function displayAssetSymbol(asset: PublicAsset): string {
  return asset.tokenId === 'wrap.near' ? 'NEAR' : asset.symbol
}

export function formatAssetBalance(asset: PublicAsset): string {
  if (
    asset.balanceRaw === null ||
    !/^\d+$/.test(asset.balanceRaw) ||
    !Number.isInteger(asset.decimals) ||
    asset.decimals < 0 ||
    asset.decimals > 36
  )
    return 'Unavailable'
  const raw = BigInt(asset.balanceRaw)
  const base = 10n ** BigInt(asset.decimals)
  const whole = raw / base
  const fraction = (raw % base).toString().padStart(asset.decimals, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''} ${displayAssetSymbol(asset)}`
}

export function supportedTransferAssets(assets: PublicAsset[]): PublicAsset[] {
  return assets.filter(
    asset =>
      /^[a-z0-9_\-.]{2,64}$/.test(asset.tokenId) &&
      Number.isInteger(asset.decimals) &&
      asset.decimals >= 0 &&
      asset.decimals <= 36
  )
}

export function parseAmountRaw(input: string, decimals: number): bigint {
  const value = input.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error('Enter a positive decimal amount.')
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) throw new Error(`Amount exceeds ${decimals} decimal places.`)
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (raw === 0n) throw new Error('Enter an amount greater than zero.')
  return raw
}

export function buildTransferRequest(
  asset: PublicAsset,
  receiver: string,
  amount: string
): PublicFunctionCallRequest[] {
  if (!supportedTransferAssets([asset]).length) throw new Error('Select a supported asset.')
  const recipient = receiver.trim()
  if (
    recipient.length < 2 ||
    recipient.length > 64 ||
    !/^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/.test(recipient)
  ) {
    throw new Error('Enter a valid NEAR account ID.')
  }
  const raw = parseAmountRaw(amount, asset.decimals)
  if (
    asset.balanceRaw !== null &&
    /^\d+$/.test(asset.balanceRaw) &&
    raw > BigInt(asset.balanceRaw)
  ) {
    throw new Error('Amount exceeds the available balance.')
  }
  return [
    {
      FunctionCall: {
        receiver_id: asset.tokenId,
        function_calls: [
          {
            method_name: 'ft_transfer',
            args: JSON.stringify({ receiver_id: recipient, amount: raw.toString() }),
            gas: '30000000000000',
            deposit: '1'
          }
        ]
      }
    }
  ]
}

export const initialRequests = JSON.stringify(
  [
    {
      FunctionCall: {
        receiver_id: '',
        function_calls: [{ method_name: '', args: '{}', gas: '30000000000000', deposit: '0' }]
      }
    }
  ],
  null,
  2
)

export function parseRequests(input: string): PublicFunctionCallRequest[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error('Transaction requests must be valid JSON.')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(item => {
      if (!item || typeof item !== 'object' || !('FunctionCall' in item)) return false
      const action = item.FunctionCall
      if (
        !action ||
        typeof action !== 'object' ||
        !('receiver_id' in action) ||
        typeof action.receiver_id !== 'string' ||
        !action.receiver_id.trim() ||
        !('function_calls' in action) ||
        !Array.isArray(action.function_calls) ||
        action.function_calls.length === 0
      )
        return false
      return action.function_calls.every((call: unknown) => {
        if (
          !call ||
          typeof call !== 'object' ||
          !('method_name' in call) ||
          typeof call.method_name !== 'string' ||
          !call.method_name.trim() ||
          !('args' in call) ||
          typeof call.args !== 'string' ||
          !('gas' in call) ||
          typeof call.gas !== 'string' ||
          !('deposit' in call) ||
          typeof call.deposit !== 'string'
        )
          return false
        try {
          JSON.parse(call.args)
        } catch {
          return false
        }
        return true
      })
    })
  )
    throw new Error('Enter a FunctionCall receiver and at least one valid method.')
  return parsed as PublicFunctionCallRequest[]
}
