import {
  parseKeystoneHardwareCredential,
  parseLedgerHardwareCredential,
  type LedgerHardwareCredential,
  type LedgerPublicAccount,
  type KeystoneHardwareCredential
} from '@/core/wallet/hardware-wallet-data'

export interface HardwareProvisioningView {
  readonly status: 'committed' | 'already-committed'
  readonly generationId: string
  readonly transactionId?: string
  readonly keyDomainId: string
  readonly accountIds: readonly string[]
}

type RuntimeMessenger = (message: Readonly<Record<string, unknown>>) => Promise<unknown>

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseResponse(value: unknown): HardwareProvisioningView {
  const response = readRecord(value, 'Hardware Wallet provisioning response')
  if (typeof response.error === 'string') throw new Error(response.error)
  if (response.success !== true) throw new Error('Hardware Wallet setup failed')
  const result = readRecord(response.result, 'Hardware Wallet provisioning result')
  if (
    (result.status !== 'committed' && result.status !== 'already-committed') ||
    typeof result.generationId !== 'string' ||
    (result.transactionId !== undefined && typeof result.transactionId !== 'string') ||
    typeof result.keyDomainId !== 'string' ||
    !Array.isArray(result.accountIds) ||
    result.accountIds.length === 0 ||
    result.accountIds.some(accountId => typeof accountId !== 'string')
  ) {
    throw new Error('Hardware Wallet setup returned an invalid result')
  }
  return Object.freeze({
    status: result.status,
    generationId: result.generationId,
    ...(result.transactionId === undefined ? {} : { transactionId: result.transactionId }),
    keyDomainId: result.keyDomainId,
    accountIds: Object.freeze([...result.accountIds] as string[])
  })
}

export function createKeystoneHardwareProvisioningClient(sendMessage: RuntimeMessenger) {
  return Object.freeze({
    provision: async (input: {
      readonly credential: KeystoneHardwareCredential
      readonly displayName: string
      readonly password?: string
      readonly birthdayHeight?: number
    }): Promise<HardwareProvisioningView> => {
      const credential = parseKeystoneHardwareCredential(input.credential)
      const response = await sendMessage({
        type: 'PROVISION_KEYSTONE_HARDWARE',
        credential,
        displayName: input.displayName,
        ...(input.password === undefined ? {} : { password: input.password }),
        ...(input.birthdayHeight === undefined ? {} : { birthdayHeight: input.birthdayHeight })
      })
      return parseResponse(response)
    }
  })
}

let productionClient: ReturnType<typeof createKeystoneHardwareProvisioningClient> | undefined

export const keystoneHardwareProvisioningClient = Object.freeze({
  provision: (input: {
    readonly credential: KeystoneHardwareCredential
    readonly displayName: string
    readonly password?: string
    readonly birthdayHeight?: number
  }) => {
    productionClient ??= createKeystoneHardwareProvisioningClient(message =>
      chrome.runtime.sendMessage(message)
    )
    return productionClient.provision(input)
  }
})

export const ledgerHardwareProvisioningClient = Object.freeze({
  getCredential: async (walletId: string): Promise<LedgerHardwareCredential> => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_LEDGER_PROVISIONING_CREDENTIAL',
      walletId
    })
    if (typeof response?.error === 'string') throw new Error(response.error)
    return parseLedgerHardwareCredential(response?.result)
  },
  provision: async (input: {
    readonly credential: LedgerHardwareCredential
    readonly displayName: string
    readonly password?: string
    readonly birthdayHeight?: number
    readonly existingKeyDomainId?: string
    readonly anchorProof?: LedgerPublicAccount
  }): Promise<HardwareProvisioningView> => {
    const credential = parseLedgerHardwareCredential(input.credential)
    const response = await chrome.runtime.sendMessage({
      type: 'PROVISION_LEDGER_HARDWARE',
      credential,
      displayName: input.displayName,
      ...(input.existingKeyDomainId === undefined
        ? {}
        : { existingKeyDomainId: input.existingKeyDomainId }),
      ...(input.anchorProof === undefined ? {} : { anchorProof: input.anchorProof }),
      ...(input.password === undefined ? {} : { password: input.password }),
      ...(input.birthdayHeight === undefined ? {} : { birthdayHeight: input.birthdayHeight })
    })
    return parseResponse(response)
  }
})
