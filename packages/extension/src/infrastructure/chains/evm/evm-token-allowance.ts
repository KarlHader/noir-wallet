import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import type { EvmContractRpc } from './evm-rpc-client'

const allowanceAbi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)'
])
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/

export async function readEvmTokenAllowance(
  rpc: EvmContractRpc,
  token: string,
  owner: string,
  spender: string
): Promise<string> {
  if (![token, owner, spender].every(address => evmAddressPattern.test(address))) {
    throw new Error('Invalid EVM allowance address')
  }
  await rpc.assertExpectedChain()
  const result = await rpc.callContract(
    token,
    encodeFunctionData({
      abi: allowanceAbi,
      functionName: 'allowance',
      args: [owner as `0x${string}`, spender as `0x${string}`]
    })
  )
  return decodeFunctionResult({
    abi: allowanceAbi,
    functionName: 'allowance',
    data: result as `0x${string}`
  }).toString()
}
