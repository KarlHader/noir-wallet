import type {
  CanonicalContent,
  PayloadDigest,
  SigningReviewIssue,
  SigningReviewLevel,
  SigningSummary
} from '@/core/keyring/domain'

export interface SigningSummaryReviewRow {
  readonly label: string
  readonly value: string
  readonly amount?: {
    readonly value: string
    readonly symbol: string
    readonly profile: 'review' | 'fee'
  }
  readonly title?: string
  readonly code?: boolean
  readonly breakAll?: boolean
  readonly tone?: 'default' | 'warning' | 'danger'
}

export interface SigningSummaryReviewSection {
  readonly title: string
  readonly rows: readonly SigningSummaryReviewRow[]
}

export interface SigningSummaryReviewIssue {
  readonly code: SigningReviewIssue['code']
  readonly title: string
  readonly description: string
}

export interface TokenAuthorizationReview {
  readonly protocol: 'Permit' | 'Permit2'
  readonly kind: 'allowance' | 'transfer'
  readonly owner: string
  readonly spender: string
  readonly signatureDeadline: string
  readonly tokens: readonly {
    readonly contractAddress: string
    readonly assetId: string
    readonly symbol: string | null
    readonly amount: string
    readonly unlimited: boolean
    readonly expiration?: string
  }[]
}

export interface SigningSummaryReviewModel {
  readonly title: string
  readonly description?: string
  readonly operation: SigningSummary['operation']
  readonly level: SigningReviewLevel
  readonly issues: readonly SigningSummaryReviewIssue[]
  readonly sections: readonly SigningSummaryReviewSection[]
  readonly tokenAuthorization?: TokenAuthorizationReview
}

export interface SigningSummaryReviewPresentation {
  readonly title: string
  readonly description?: string
  readonly sections: readonly SigningSummaryReviewSection[]
  readonly tokenAuthorization?: TokenAuthorizationReview
}

export function reviewRow(
  label: string,
  value: string | number | boolean | null,
  options: Omit<SigningSummaryReviewRow, 'label' | 'value'> = {}
): SigningSummaryReviewRow {
  return {
    label,
    value:
      value === null ? 'None' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : `${value}`,
    ...options
  }
}

export function canonicalContentRows(
  label: string,
  content: CanonicalContent
): readonly SigningSummaryReviewRow[] {
  return [
    reviewRow(label, content.value || '(empty)', {
      code: content.encoding !== 'utf8',
      breakAll: true
    }),
    reviewRow(`${label} encoding`, content.encoding),
    reviewRow(`${label} size`, `${content.byteLength} bytes`),
    reviewRow(`${label} SHA-256`, content.sha256, { code: true, breakAll: true })
  ]
}

export function payloadDigestRows(
  label: string,
  digest: PayloadDigest
): readonly SigningSummaryReviewRow[] {
  return [
    reviewRow(`${label} size`, `${digest.byteLength} bytes`),
    reviewRow(`${label} SHA-256`, digest.sha256, { code: true, breakAll: true })
  ]
}

const ISSUE_COPY: Readonly<
  Record<SigningReviewIssue['code'], { readonly title: string; readonly description: string }>
> = Object.freeze({
  'contract-creation': {
    title: 'Contract creation',
    description: 'This transaction creates a contract instead of calling an existing address.'
  },
  'external-input': {
    title: 'External Bitcoin input',
    description: 'At least one input is not owned by the signing account.'
  },
  'missing-chain-binding': {
    title: 'Missing chain binding',
    description: 'The signed content does not uniquely bind the intended chain.'
  },
  'non-default-sighash': {
    title: 'Non-default signature rules',
    description: 'At least one Bitcoin input uses a non-default sighash type.'
  },
  'unknown-output': {
    title: 'Unknown Bitcoin output',
    description: 'An output could not be verified as a recipient or change output.'
  },
  'unrecognized-call': {
    title: 'Unknown contract call',
    description: 'The contract method could not be decoded. Noir Wallet will not sign it.'
  },
  'unrecognized-instruction': {
    title: 'Unknown Solana instruction',
    description: 'An instruction could not be decoded. Verify its program, accounts, and raw data.'
  },
  'simulation-failed': {
    title: 'Simulation failed',
    description:
      'The network could not simulate this transaction successfully. It may fail or still charge a fee.'
  },
  'unrecognized-action': {
    title: 'Unknown NEAR action',
    description: 'An action could not be decoded. Noir Wallet will not sign it.'
  },
  'active-permission': {
    title: 'TRON active permission',
    description:
      'This uses an active permission. Its operations, keys, weights, and threshold must be verified before signing.'
  },
  'owner-signer-mismatch': {
    title: 'Owner and signer differ',
    description: 'The TRON contract owner is different from the selected signing address.'
  },
  multisign: {
    title: 'Partially signed transaction',
    description: 'This TRON transaction already contains one or more signatures.'
  },
  'token-approval': {
    title: 'Token spending approval',
    description: 'This lets another address spend tokens from the owner account.'
  },
  'unlimited-token-approval': {
    title: 'Unlimited token approval',
    description: 'The allowance is the maximum uint256 value and does not expire automatically.'
  },
  'opaque-message': {
    title: 'Opaque signed content',
    description: 'The content is not plain UTF-8 text. Verify its digest and source carefully.'
  }
})

const ISSUE_PRIORITY: Readonly<Record<SigningReviewIssue['code'], number>> = Object.freeze({
  'unrecognized-call': 0,
  'unrecognized-instruction': 0,
  'simulation-failed': 0,
  'unrecognized-action': 0,
  'unlimited-token-approval': 0,
  'token-approval': 1,
  'owner-signer-mismatch': 2,
  'active-permission': 3,
  multisign: 4,
  'contract-creation': 5,
  'external-input': 5,
  'missing-chain-binding': 5,
  'non-default-sighash': 5,
  'unknown-output': 5,
  'opaque-message': 5
})

export function reviewIssueCopy(
  issue: SigningReviewIssue,
  level: SigningReviewLevel
): SigningSummaryReviewIssue {
  const copy = ISSUE_COPY[issue.code]
  const subject = issue.subjectIndex === undefined ? '' : ` Item ${issue.subjectIndex + 1}.`
  const description =
    level !== 'blocked' && issue.code === 'unrecognized-call'
      ? 'The contract method could not be decoded. Verify the destination and full calldata before continuing.'
      : copy.description
  return {
    code: issue.code,
    title: copy.title,
    description: `${description}${subject}`
  }
}

export function completeReviewModel(
  summary: SigningSummary,
  presentation: SigningSummaryReviewPresentation
): SigningSummaryReviewModel {
  return {
    ...presentation,
    operation: summary.operation,
    level: summary.review.level,
    issues: summary.review.issues
      .map((issue, index) => ({ issue, index }))
      .sort(
        (left, right) =>
          ISSUE_PRIORITY[left.issue.code] - ISSUE_PRIORITY[right.issue.code] ||
          left.index - right.index
      )
      .map(({ issue }) => reviewIssueCopy(issue, summary.review.level)),
    sections: [
      ...presentation.sections,
      {
        title: 'Request',
        rows: [
          reviewRow('Schema', summary.schema, { code: true, breakAll: true }),
          reviewRow('Chain ID', summary.chainId, { code: true, breakAll: true })
        ]
      }
    ]
  }
}
