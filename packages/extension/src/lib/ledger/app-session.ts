export async function openAndVerifyLedgerApp(
  appName: string,
  openApp: (name: string) => Promise<void>,
  readApp: () => Promise<{ readonly name: string; readonly version: string } | null>,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  await openApp(appName)
  signal?.throwIfAborted()
  const app = await readApp()
  signal?.throwIfAborted()
  if (app?.name !== appName) {
    throw new Error(`Unable to verify the Ledger ${appName} app`)
  }
  return app.version
}
