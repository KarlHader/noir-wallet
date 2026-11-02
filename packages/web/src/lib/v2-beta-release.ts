export interface V2BetaRelease {
  version: string
  releaseDate?: string
  downloadUrl: string
  releaseNotesUrl: string
}

const version = '2.0.0-beta.1'
const releasesUrl = 'https://github.com/NoirWallet/noir-wallet/releases'

export const v2BetaRelease: V2BetaRelease | null = {
  version,
  downloadUrl: `${releasesUrl}/download/v${version}/noir-wallet-v${version}.zip`,
  releaseNotesUrl: `${releasesUrl}/tag/v${version}`
}

export function getV2BetaRelease(): V2BetaRelease | null {
  return v2BetaRelease
}
