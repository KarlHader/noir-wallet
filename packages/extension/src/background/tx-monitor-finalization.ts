export async function deliverTerminalNotificationAndRemoveTask(
  shouldNotify: boolean,
  notify: () => void,
  removeTask: () => Promise<void>
): Promise<void> {
  if (shouldNotify) notify()
  await removeTask()
}
