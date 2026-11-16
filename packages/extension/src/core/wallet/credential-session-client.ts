export async function hasAttestedCredentialSession(): Promise<boolean> {
  const response: unknown = await chrome.runtime.sendMessage({ type: 'GET_WALLET_SESSION_STATE' })
  return (
    typeof response === 'object' &&
    response !== null &&
    !Array.isArray(response) &&
    (response as { active?: unknown }).active === true
  )
}
