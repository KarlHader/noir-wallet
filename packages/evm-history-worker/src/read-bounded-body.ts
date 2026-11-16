/** Stop reading as soon as a body exceeds its limit, including chunked responses. */
export async function readBoundedBody(
  message: Request | Response,
  maximumBytes: number,
  tooLarge: () => Error
): Promise<Uint8Array> {
  const declaredLength = Number(message.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await message.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!message.body) return new Uint8Array()
  const reader = message.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
