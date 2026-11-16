import type { MnemonicWordCount } from '@/config/wallet'
import { getResponseErrorMessage } from '@/lib/errors'
import type { AccountNetworkFamily } from './account-network-selection'

type SoftwareWalletProvisioningMode = 'create' | 'import'

function responseRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function generateAddWalletMnemonic(wordCount: MnemonicWordCount): Promise<string[]> {
  const record = responseRecord(
    await chrome.runtime.sendMessage({ type: 'GENERATE_ADD_WALLET_MNEMONIC', wordCount })
  )
  if (record?.success !== true || typeof record.mnemonic !== 'string') {
    throw new Error(getResponseErrorMessage(record) ?? 'Recovery phrase generation failed')
  }
  const words = record.mnemonic.split(' ')
  if (words.length !== wordCount) {
    throw new Error('Secure module returned an unexpected recovery phrase length')
  }
  return words
}

export async function provisionAdditionalSoftwareWallet(input: {
  readonly mode: SoftwareWalletProvisioningMode
  readonly mnemonic: string
  readonly accountName: string
  readonly birthdayHeight?: number
  readonly selectedNetworkFamilies?: readonly AccountNetworkFamily[]
}): Promise<string> {
  const record = responseRecord(
    await chrome.runtime.sendMessage({
      type: 'ADD_SOFTWARE_WALLET',
      mode: input.mode,
      mnemonic: input.mnemonic,
      accountName: input.accountName,
      ...(input.birthdayHeight === undefined ? {} : { birthdayHeight: input.birthdayHeight }),
      ...(input.selectedNetworkFamilies === undefined
        ? {}
        : { selectedNetworkFamilies: input.selectedNetworkFamilies })
    })
  )
  if (record?.success !== true || typeof record.walletId !== 'string') {
    throw new Error(getResponseErrorMessage(record) ?? 'Wallet setup failed')
  }
  return record.walletId
}
