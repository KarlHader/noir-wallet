import type { KeyDomainSource } from '@/core/keyring/domain'

type NearExecutionKeySource =
  | Readonly<{ kind: 'software' | 'hardware' }>
  | Pick<Extract<KeyDomainSource, { kind: 'private-key' }>, 'kind' | 'chainFamily'>

/** Software vaults and imported NEAR keys can derive a PEA. Hardware signers cannot. */
export function supportsNearPrivateExecution(
  source: NearExecutionKeySource | null | undefined
): boolean {
  return (
    source?.kind === 'software' || (source?.kind === 'private-key' && source.chainFamily === 'near')
  )
}
