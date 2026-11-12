import type { StarknetTransferOrchestrator } from './starknet-transfer-orchestrator'

export async function monitorStarknetTransfers(
  orchestrator: Pick<StarknetTransferOrchestrator, 'monitor'>,
  signal?: AbortSignal
): Promise<void> {
  await orchestrator.monitor(signal)
}
