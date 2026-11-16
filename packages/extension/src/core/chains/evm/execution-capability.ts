import type { KeyDomainSource } from '@/core/keyring/domain'

type EvmExecutionKeySource =
  | Readonly<{ kind: 'software' | 'hardware' }>
  | Pick<Extract<KeyDomainSource, { kind: 'private-key' }>, 'kind' | 'chainFamily'>

export function supportsEvmPrivateExecution(
  source: EvmExecutionKeySource | null | undefined
): boolean {
  return (
    source?.kind === 'software' ||
    (source?.kind === 'private-key' && source.chainFamily === 'eip155')
  )
}
