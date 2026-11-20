const FINGERPRINT_HEX_LENGTH = 24

// Three distinct FNV-1a starting states give three independent-looking 32-bit words (96 bits).
const FNV_OFFSET_BASES = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b] as const
const FNV_PRIME = 0x01000193

function fnv1a32(input: string, offsetBasis: number): number {
  let hash = offsetBasis
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

export function formatFingerprint(hex: string): string {
  const groups = hex
    .slice(0, FINGERPRINT_HEX_LENGTH)
    .toUpperCase()
    .match(/.{1,4}/g)
  return groups ? groups.join(' ') : ''
}

// Mock only: a synchronous, non-cryptographic hash so the flow is deterministic under plain Node.
// The real fingerprint will come from the WASM package.
export function deriveMockFingerprint(seed: string, stage: 'r1' | 'final'): string {
  const input = `${seed}:${stage}`
  return FNV_OFFSET_BASES.map(basis => fnv1a32(input, basis).toString(16).padStart(8, '0')).join('')
}
