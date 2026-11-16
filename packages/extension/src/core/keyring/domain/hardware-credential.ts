export const HARDWARE_CHAIN_CAPABILITIES = Object.freeze([
  'zcash',
  'bitcoin',
  'evm',
  'solana',
  'tron',
  'near'
] as const)

export const KEYSTONE_FIRMWARE_PROFILES = Object.freeze([
  'cypherpunk',
  'multi-coin',
  'bitcoin-only'
] as const)

export type HardwareChainCapability = (typeof HARDWARE_CHAIN_CAPABILITIES)[number]
export type KeystoneFirmwareProfile = (typeof KEYSTONE_FIRMWARE_PROFILES)[number]

export interface HardwareCredentialMetadata {
  readonly vendor: string
  readonly firmwareProfile: string
  readonly capabilities: readonly HardwareChainCapability[]
}

const capabilitySet = new Set<HardwareChainCapability>(HARDWARE_CHAIN_CAPABILITIES)

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function parseMetadataString(value: unknown, label: string, maxLength = 64): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid hardware ${label}`)
  }
  return value
}

export function parseHardwareCredentialMetadata(value: unknown): HardwareCredentialMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['vendor', 'firmwareProfile', 'capabilities']) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length === 0 ||
    value.capabilities.length > HARDWARE_CHAIN_CAPABILITIES.length
  ) {
    throw new Error('Invalid hardware credential metadata')
  }
  const capabilities = value.capabilities.map(capability => {
    if (
      typeof capability !== 'string' ||
      !capabilitySet.has(capability as HardwareChainCapability)
    ) {
      throw new Error('Invalid hardware chain capability')
    }
    return capability as HardwareChainCapability
  })
  if (
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(
      (capability, index) =>
        HARDWARE_CHAIN_CAPABILITIES.indexOf(capability) <=
        HARDWARE_CHAIN_CAPABILITIES.indexOf(capabilities[index - 1])
    )
  ) {
    throw new Error('Hardware chain capabilities must be unique and canonical')
  }

  const vendor = parseMetadataString(value.vendor, 'vendor')
  const firmwareProfile = parseMetadataString(value.firmwareProfile, 'firmware profile')
  if (
    vendor === 'keystone' &&
    !KEYSTONE_FIRMWARE_PROFILES.includes(firmwareProfile as KeystoneFirmwareProfile)
  ) {
    throw new Error('Invalid Keystone firmware profile')
  }
  if (
    vendor === 'ledger' &&
    ((firmwareProfile !== 'zcash' && firmwareProfile !== 'multi-app') ||
      (firmwareProfile === 'zcash' && (capabilities.length !== 1 || capabilities[0] !== 'zcash')) ||
      capabilities.includes('tron'))
  ) {
    throw new Error('Invalid Ledger firmware capability binding')
  }
  return Object.freeze({
    vendor,
    firmwareProfile,
    capabilities: Object.freeze(capabilities)
  })
}

export function hardwareCredentialMetadataEquals(
  left: HardwareCredentialMetadata,
  right: HardwareCredentialMetadata
): boolean {
  return (
    left.vendor === right.vendor &&
    left.firmwareProfile === right.firmwareProfile &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((capability, index) => capability === right.capabilities[index])
  )
}
