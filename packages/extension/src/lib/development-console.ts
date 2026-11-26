export const developmentConsoleErrors =
  typeof __BUILD_CHANNEL__ !== 'undefined' && __BUILD_CHANNEL__ === 'development'

export function developmentErrorArgs(error: unknown): unknown[] {
  return developmentConsoleErrors && error !== undefined ? [error] : []
}

export function logDevelopmentError(message: string, error: unknown): void {
  if (developmentConsoleErrors) console.error(message, error)
}
