import { getDiagnosticErrorDetails, sanitizeDiagnosticMessage } from './diagnostic-log'

function errorMessages(details: unknown): string[] {
  if (typeof details === 'string') return [details]
  if (!details || typeof details !== 'object') return []
  const fields = details as Record<string, unknown>
  const message = [
    fields.name,
    fields._tag,
    fields.message,
    ...['code', 'errorCode', 'status', 'statusCode'].flatMap(key =>
      typeof fields[key] === 'string' || typeof fields[key] === 'number'
        ? [`${key}=${fields[key]}`]
        : []
    )
  ]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join(': ')
  return [
    message,
    ...['cause', 'originalError', 'err'].flatMap(key => errorMessages(fields[key]))
  ].filter(Boolean)
}

/** Only an explicit chooser dismissal is a cancellation, not a transport failure. */
export function isHardwareDeviceSelectionCancelled(error: unknown): boolean {
  const inspect = (details: unknown): boolean => {
    if (!details || typeof details !== 'object') return false
    const fields = details as Record<string, unknown>
    if (
      fields.name === 'NotFoundError' &&
      typeof fields.message === 'string' &&
      /user cancel(?:led|ed).*requestDevice.*chooser|^No device selected\.?$/i.test(fields.message)
    )
      return true
    if (fields._tag === 'NoAccessibleDeviceError') {
      const original = fields.originalError
      if (
        original &&
        typeof original === 'object' &&
        (original as Record<string, unknown>).message === 'No selected device'
      )
        return true
    }
    return ['cause', 'originalError', 'err'].some(key => inspect(fields[key]))
  }
  return inspect(getDiagnosticErrorDetails(error))
}

/** Keep vendor/WASM error text while excluding transaction and credential material. */
export function formatHardwareSigningError(error: unknown): string {
  const message = [...new Set(errorMessages(getDiagnosticErrorDetails(error)))].join(' → ')
  // PCZT/PSBT bytes may appear in upstream parser errors without a field name.
  return sanitizeDiagnosticMessage(
    (message || 'Hardware signing failed without an error message.')
      .replace(/\b[A-Za-z0-9+/_=-]{80,}\b/g, '[Encoded data redacted]')
      .replace(/\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){15,}\s*\]/g, '[Bytes redacted]')
  )
}
