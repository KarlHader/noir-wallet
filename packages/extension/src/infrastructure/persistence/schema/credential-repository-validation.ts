import {
  CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION,
  CREDENTIAL_SET_SCHEMA_VERSION,
  parseCredentialEnvelopeAad,
  parseCredentialGenerationId,
  parseCredentialRef,
  parseCredentialSetManifest,
  parseKeyDomainId
} from '@/core/keyring/domain'
import {
  CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
  type CredentialArtifactRef,
  type CredentialRepositoryErrorCode,
  type CredentialRetirementReason,
  type CredentialRetirementRecord,
  type CredentialSetRecord,
  type CredentialTransactionId,
  type CredentialTransactionJournal,
  type CredentialTransactionOperation,
  type CredentialTransactionPhase,
  type CredentialTransition,
  type EncryptedCredentialEnvelopeRecord,
  type StorageV2GenerationId
} from '@/ports/repositories'

export const CREDENTIAL_REPOSITORY_LIMITS = Object.freeze({
  encryptedPayloadBytes: 16 * 1024 * 1024,
  transitions: 100,
  artifactRefsPerTransition: 32
})

const OPERATIONS = new Set<CredentialTransactionOperation>([
  'create',
  'import',
  'migrate',
  'change-password',
  'remove'
])
const PHASES = new Set<CredentialTransactionPhase>([
  'staging',
  'verified',
  'committing',
  'committed-pending-cleanup',
  'complete',
  'failed'
])
const RETIREMENT_REASONS = new Set<CredentialRetirementReason>(['superseded', 'removed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
  )
}

function parseIdentifier<T extends string>(value: unknown, label: string, maxLength = 512): T {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw new Error(`Invalid ${label}`)
  }
  return value as T
}

function parseTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function parseOperation(value: unknown): CredentialTransactionOperation {
  if (typeof value !== 'string' || !OPERATIONS.has(value as CredentialTransactionOperation)) {
    throw new Error('Invalid credential transaction operation')
  }
  return value as CredentialTransactionOperation
}

function parsePhase(value: unknown): CredentialTransactionPhase {
  if (typeof value !== 'string' || !PHASES.has(value as CredentialTransactionPhase)) {
    throw new Error('Invalid credential transaction phase')
  }
  return value as CredentialTransactionPhase
}

function parseErrorCode(value: unknown): CredentialRepositoryErrorCode {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error('Invalid credential repository error code')
  }
  return value as CredentialRepositoryErrorCode
}

export function parseCredentialArtifactRef(value: unknown): CredentialArtifactRef {
  return parseIdentifier<CredentialArtifactRef>(value, 'CredentialArtifactRef')
}

function parseArtifactRefs(value: unknown, label: string): readonly CredentialArtifactRef[] {
  if (
    !Array.isArray(value) ||
    value.length > CREDENTIAL_REPOSITORY_LIMITS.artifactRefsPerTransition
  ) {
    throw new Error(`Invalid ${label}`)
  }
  const refs = value.map(parseCredentialArtifactRef)
  if (new Set(refs).size !== refs.length) {
    throw new Error(`Duplicate ${label}`)
  }
  return Object.freeze(refs)
}

function parseTargetFields(value: Record<string, unknown>) {
  return {
    targetCredentialGenerationId: parseCredentialGenerationId(value.targetCredentialGenerationId),
    targetCredentialSetRef: parseCredentialRef(value.targetCredentialSetRef),
    stagedRefs: parseArtifactRefs(value.stagedRefs, 'stagedRefs')
  }
}

function parseCredentialTransition(value: unknown): CredentialTransition {
  if (!isRecord(value)) throw new Error('Invalid credential transition')
  const keyDomainId = parseKeyDomainId(value.keyDomainId)
  if (value.kind === 'provision') {
    if (
      !hasExactKeys(value, [
        'kind',
        'keyDomainId',
        'targetCredentialGenerationId',
        'targetCredentialSetRef',
        'stagedRefs'
      ])
    ) {
      throw new Error('Invalid provision credential transition')
    }
    return Object.freeze({ kind: 'provision', keyDomainId, ...parseTargetFields(value) })
  }
  if (value.kind === 'replace') {
    if (
      !hasExactKeys(value, [
        'kind',
        'keyDomainId',
        'sourceCredentialGenerationId',
        'targetCredentialGenerationId',
        'targetCredentialSetRef',
        'stagedRefs',
        'retiredRefs'
      ])
    ) {
      throw new Error('Invalid replace credential transition')
    }
    const sourceCredentialGenerationId = parseCredentialGenerationId(
      value.sourceCredentialGenerationId
    )
    const target = parseTargetFields(value)
    const retiredRefs = parseArtifactRefs(value.retiredRefs, 'retiredRefs')
    if (
      sourceCredentialGenerationId === target.targetCredentialGenerationId ||
      target.stagedRefs.some(ref => retiredRefs.includes(ref))
    ) {
      throw new Error('Credential replacement must use disjoint generations and artifacts')
    }
    return Object.freeze({
      kind: 'replace',
      keyDomainId,
      sourceCredentialGenerationId,
      ...target,
      retiredRefs
    })
  }
  if (value.kind === 'retire') {
    if (
      !hasExactKeys(value, ['kind', 'keyDomainId', 'sourceCredentialGenerationId', 'retiredRefs'])
    ) {
      throw new Error('Invalid retire credential transition')
    }
    return Object.freeze({
      kind: 'retire',
      keyDomainId,
      sourceCredentialGenerationId: parseCredentialGenerationId(value.sourceCredentialGenerationId),
      retiredRefs: parseArtifactRefs(value.retiredRefs, 'retiredRefs')
    })
  }
  throw new Error('Invalid credential transition kind')
}

function assertOperationTransitions(
  operation: CredentialTransactionOperation,
  transitions: readonly CredentialTransition[]
): void {
  const allowedKinds: ReadonlySet<CredentialTransition['kind']> =
    operation === 'change-password'
      ? new Set(['replace'])
      : operation === 'remove'
        ? new Set(['retire', 'replace'])
        : operation === 'migrate'
          ? new Set(['provision', 'replace'])
          : new Set(['provision'])
  if (transitions.some(transition => !allowedKinds.has(transition.kind))) {
    throw new Error('Credential transitions do not match the transaction operation')
  }
}

function assertUniqueTransitions(transitions: readonly CredentialTransition[]): void {
  const keyDomainIds = transitions.map(transition => transition.keyDomainId)
  if (new Set(keyDomainIds).size !== keyDomainIds.length) {
    throw new Error('Duplicate KeyDomain in credential transaction')
  }

  const sourceGenerationIds = transitions.flatMap(transition =>
    transition.kind === 'provision' ? [] : [transition.sourceCredentialGenerationId]
  )
  const targetGenerationIds = transitions.flatMap(transition =>
    transition.kind === 'retire' ? [] : [transition.targetCredentialGenerationId]
  )
  if (
    new Set(sourceGenerationIds).size !== sourceGenerationIds.length ||
    new Set(targetGenerationIds).size !== targetGenerationIds.length
  ) {
    throw new Error('Duplicate credential generation in transaction')
  }

  const allStagedRefs = transitions.flatMap(transition =>
    transition.kind === 'retire' ? [] : transition.stagedRefs
  )
  const allRetiredRefs = transitions.flatMap(transition =>
    transition.kind === 'provision' ? [] : transition.retiredRefs
  )
  if (
    new Set(allStagedRefs).size !== allStagedRefs.length ||
    new Set(allRetiredRefs).size !== allRetiredRefs.length ||
    allStagedRefs.some(ref => allRetiredRefs.includes(ref))
  ) {
    throw new Error('Credential artifact refs must be unique and disjoint')
  }
}

export function parseCredentialTransactionId(value: unknown): CredentialTransactionId {
  return parseIdentifier<CredentialTransactionId>(value, 'CredentialTransactionId', 128)
}

export function parseCredentialRepositoryErrorCode(value: unknown): CredentialRepositoryErrorCode {
  return parseErrorCode(value)
}

export function parseEncryptedCredentialEnvelopeRecord(
  value: unknown
): EncryptedCredentialEnvelopeRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'transactionId',
      'aad',
      'encryptedPayload',
      'createdAt'
    ]) ||
    value.schemaVersion !== CREDENTIAL_REPOSITORY_SCHEMA_VERSION ||
    !(value.encryptedPayload instanceof Uint8Array) ||
    value.encryptedPayload.byteLength === 0 ||
    value.encryptedPayload.byteLength > CREDENTIAL_REPOSITORY_LIMITS.encryptedPayloadBytes
  ) {
    throw new Error('Invalid encrypted credential envelope record')
  }
  return Object.freeze({
    schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
    transactionId: parseCredentialTransactionId(value.transactionId),
    aad: parseCredentialEnvelopeAad(value.aad),
    encryptedPayload: new Uint8Array(value.encryptedPayload),
    createdAt: parseTimestamp(value.createdAt, 'encrypted credential createdAt')
  })
}

export function parseCredentialSetRecord(value: unknown): CredentialSetRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'transactionId', 'credentialSetRef', 'manifest']) ||
    value.schemaVersion !== CREDENTIAL_REPOSITORY_SCHEMA_VERSION
  ) {
    throw new Error('Invalid CredentialSet record')
  }
  const credentialSetRef = parseCredentialRef(value.credentialSetRef)
  const manifest = parseCredentialSetManifest(value.manifest)
  if (
    Object.values(manifest.engines).some(
      engine => engine !== undefined && String(engine.credentialRef) === String(credentialSetRef)
    )
  ) {
    throw new Error('CredentialSet ref must not alias an engine credential ref')
  }
  return Object.freeze({
    schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
    transactionId: parseCredentialTransactionId(value.transactionId),
    credentialSetRef,
    manifest
  })
}

export function parseCredentialTransactionJournal(value: unknown): CredentialTransactionJournal {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'schemaVersion',
        'transactionId',
        'operation',
        'targetMetadataGenerationId',
        'transitions',
        'phase',
        'revision',
        'createdAt',
        'updatedAt'
      ],
      ['lastErrorCode']
    ) ||
    value.schemaVersion !== CREDENTIAL_REPOSITORY_SCHEMA_VERSION ||
    !Array.isArray(value.transitions) ||
    value.transitions.length === 0 ||
    value.transitions.length > CREDENTIAL_REPOSITORY_LIMITS.transitions
  ) {
    throw new Error('Invalid credential transaction journal')
  }

  const operation = parseOperation(value.operation)
  const transitions = Object.freeze(value.transitions.map(parseCredentialTransition))
  assertOperationTransitions(operation, transitions)
  assertUniqueTransitions(transitions)

  const phase = parsePhase(value.phase)
  const createdAt = parseTimestamp(value.createdAt, 'credential journal createdAt')
  const updatedAt = parseTimestamp(value.updatedAt, 'credential journal updatedAt')
  if (updatedAt < createdAt || (phase === 'failed' && value.lastErrorCode === undefined)) {
    throw new Error('Invalid credential transaction journal state')
  }

  return Object.freeze({
    schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
    transactionId: parseCredentialTransactionId(value.transactionId),
    operation,
    targetMetadataGenerationId: parseIdentifier<StorageV2GenerationId>(
      value.targetMetadataGenerationId,
      'targetMetadataGenerationId',
      128
    ),
    transitions,
    phase,
    revision: parseTimestamp(value.revision, 'credential journal revision'),
    createdAt,
    updatedAt,
    ...(value.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: parseErrorCode(value.lastErrorCode) })
  })
}

export function parseCredentialRetirementRecord(value: unknown): CredentialRetirementRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'schemaVersion',
        'credentialSetRef',
        'credentialGenerationId',
        'keyDomainId',
        'reason',
        'transactionId',
        'retiredAt'
      ],
      ['replacementCredentialSetRef']
    ) ||
    value.schemaVersion !== CREDENTIAL_REPOSITORY_SCHEMA_VERSION ||
    typeof value.reason !== 'string' ||
    !RETIREMENT_REASONS.has(value.reason as CredentialRetirementReason)
  ) {
    throw new Error('Invalid credential retirement record')
  }

  const reason = value.reason as CredentialRetirementReason
  const credentialSetRef = parseCredentialRef(value.credentialSetRef)
  const replacementCredentialSetRef =
    value.replacementCredentialSetRef === undefined
      ? undefined
      : parseCredentialRef(value.replacementCredentialSetRef)
  if (
    (reason === 'superseded' && replacementCredentialSetRef === undefined) ||
    (reason === 'removed' && replacementCredentialSetRef !== undefined) ||
    replacementCredentialSetRef === credentialSetRef
  ) {
    throw new Error('Invalid credential retirement replacement')
  }

  return Object.freeze({
    schemaVersion: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
    credentialSetRef,
    credentialGenerationId: parseCredentialGenerationId(value.credentialGenerationId),
    keyDomainId: parseKeyDomainId(value.keyDomainId),
    reason,
    ...(replacementCredentialSetRef === undefined ? {} : { replacementCredentialSetRef }),
    transactionId: parseCredentialTransactionId(value.transactionId),
    retiredAt: parseTimestamp(value.retiredAt, 'credential retiredAt')
  })
}

export const CREDENTIAL_REPOSITORY_SCHEMA_DEPENDENCIES = Object.freeze({
  repository: CREDENTIAL_REPOSITORY_SCHEMA_VERSION,
  credentialSet: CREDENTIAL_SET_SCHEMA_VERSION,
  envelopeAad: CREDENTIAL_ENVELOPE_AAD_SCHEMA_VERSION
})
