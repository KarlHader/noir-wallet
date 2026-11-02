import { getEvmNetworkConfigs } from '@/config/networks'
import {
  DEFAULT_CHAIN_ENDPOINT_SETTINGS,
  parseChainEndpointSettings,
  type CustomEvmNetwork
} from '@/core/chains/chain-endpoint-settings'
import type { Network } from '@/types'

export interface CustomEvmNetworkForm {
  name: string
  chainId: string
  currencyName: string
  currencySymbol: string
  decimals: string
  rpcUrl: string
  explorerUrl: string
}

export type CustomEvmNetworkField = keyof CustomEvmNetworkForm
export type CustomEvmNetworkErrors = Partial<Record<CustomEvmNetworkField, string>>

export function emptyCustomEvmNetworkForm(): CustomEvmNetworkForm {
  return {
    name: '',
    chainId: '',
    currencyName: '',
    currencySymbol: '',
    decimals: '18',
    rpcUrl: '',
    explorerUrl: ''
  }
}

export function customEvmNetworkToForm(network: CustomEvmNetwork): CustomEvmNetworkForm {
  return {
    name: network.displayName,
    chainId: String(network.numericChainId),
    currencyName: network.nativeCurrency.name,
    currencySymbol: network.nativeCurrency.symbol,
    decimals: String(network.nativeCurrency.decimals),
    rpcUrl: network.rpc.url,
    explorerUrl: network.explorer?.baseUrl ?? ''
  }
}

export function buildCustomEvmNetwork(
  form: CustomEvmNetworkForm,
  networkMode: Network,
  existing?: CustomEvmNetwork
): { network?: CustomEvmNetwork; errors: CustomEvmNetworkErrors } {
  const errors: CustomEvmNetworkErrors = {}
  const values = Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, value.trim()])
  ) as unknown as CustomEvmNetworkForm
  for (const field of ['name', 'chainId', 'currencyName', 'currencySymbol', 'rpcUrl'] as const) {
    if (!values[field]) errors[field] = 'Required'
  }
  if (
    values.chainId &&
    (!/^[1-9][0-9]*$/.test(values.chainId) || !Number.isSafeInteger(Number(values.chainId)))
  ) {
    errors.chainId = 'Enter a positive decimal chain ID'
  }
  if (existing && values.chainId !== String(existing.numericChainId)) {
    errors.chainId = 'Chain ID cannot be changed'
  }
  if (!errors.chainId) {
    const builtInMode = (['mainnet', 'testnet'] as const).find(mode =>
      getEvmNetworkConfigs(mode).some(item => item.numericChainId === Number(values.chainId))
    )
    if (builtInMode) {
      errors.chainId =
        builtInMode === networkMode
          ? 'This chain is built in'
          : `This chain is built in on ${builtInMode === 'mainnet' ? 'Mainnet' : 'Testnet'}`
    }
  }
  if (
    values.decimals === '' ||
    !/^(0|[1-9][0-9]*)$/.test(values.decimals) ||
    Number(values.decimals) > 255
  ) {
    errors.decimals = 'Enter a number from 0 to 255'
  }
  if (Object.keys(errors).length > 0) return { errors }

  const network = {
    chainId: `eip155:${values.chainId}`,
    numericChainId: Number(values.chainId),
    displayName: values.name,
    nativeCurrency: {
      name: values.currencyName,
      symbol: values.currencySymbol,
      decimals: Number(values.decimals)
    },
    rpc: { protocol: 'evm-json-rpc', label: values.name, url: values.rpcUrl },
    ...(values.explorerUrl
      ? {
          explorer: {
            label: values.name,
            baseUrl: values.explorerUrl,
            transactionPath: existing?.explorer?.transactionPath ?? 'tx'
          }
        }
      : {})
  }
  try {
    const parsed = parseChainEndpointSettings({
      ...DEFAULT_CHAIN_ENDPOINT_SETTINGS,
      customEvmNetworks: [network]
    })
    return { network: parsed.customEvmNetworks[0], errors }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid network'
    const field: CustomEvmNetworkField = /explorer/i.test(message)
      ? 'explorerUrl'
      : /RPC/i.test(message)
        ? 'rpcUrl'
        : /symbol/i.test(message)
          ? 'currencySymbol'
          : /currency name/i.test(message)
            ? 'currencyName'
            : /decimal/i.test(message)
              ? 'decimals'
              : /chain ID/i.test(message)
                ? 'chainId'
                : 'name'
    return { errors: { [field]: message } }
  }
}
