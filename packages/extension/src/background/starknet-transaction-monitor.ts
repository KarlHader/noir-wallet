import type { BackgroundStarknetTransferController } from './starknet-transfer-controller'
import { monitorStarknetTransfers } from '@/infrastructure/chains/starknet'

export const STARKNET_TRANSACTION_MONITOR_ALARM = 'starknet-transaction-monitor-alarm'

export class BackgroundStarknetTransactionMonitor {
  constructor(private readonly controller: BackgroundStarknetTransferController) {}

  async init(): Promise<void> {
    await this.handleAlarm()
  }

  async handleAlarm(): Promise<void> {
    await monitorStarknetTransfers(this.controller)
    const pending = await this.controller.listPending()
    const active = pending.some(
      record => record.status === 'pending' && record.phase !== 'awaiting-approval'
    )
    if (active) {
      await chrome.alarms.create(STARKNET_TRANSACTION_MONITOR_ALARM, { delayInMinutes: 0.25 })
    } else {
      await chrome.alarms.clear(STARKNET_TRANSACTION_MONITOR_ALARM)
    }
  }
}
