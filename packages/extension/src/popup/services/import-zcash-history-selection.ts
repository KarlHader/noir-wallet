export type ImportZcashHistorySelection =
  | Readonly<{ mode: 'new' }>
  | Readonly<{ mode: 'restore'; method: 'height' }>
  | Readonly<{ mode: 'restore'; method: 'date'; date: string }>

export function getImportZcashHistoryDefaults(
  birthdayHeight: number | undefined,
  selection: ImportZcashHistorySelection | null
): Readonly<{
  historyMode: 'new' | 'restore'
  restoreMethod: 'date' | 'height'
  syncDate: string | null
  syncHeight: string
}> {
  return Object.freeze({
    historyMode: selection?.mode ?? (birthdayHeight === undefined ? 'new' : 'restore'),
    restoreMethod:
      selection?.mode === 'restore'
        ? selection.method
        : birthdayHeight === undefined
          ? 'date'
          : 'height',
    syncDate: selection?.mode === 'restore' && selection.method === 'date' ? selection.date : null,
    syncHeight: birthdayHeight === undefined ? '' : String(birthdayHeight)
  })
}
