import type { ZeroIndexerRegistryDocument } from '@/core/zcash/zero-indexer'

export const ZERO_INDEXER_REGISTRY_URL = 'https://rpc.zknoir.com/v1/zero-indexer-endpoints'

export const DEFAULT_ZERO_INDEXER_REGISTRY: ZeroIndexerRegistryDocument = {
  version: 1,
  updatedAt: '2026-10-11T00:00:00.000Z',
  networks: {
    mainnet: [
      { id: 'zero-indexer-mainnet', label: 'ZeroIndexer', url: 'https://tee.unsafe.zec.rocks' }
    ],
    testnet: [
      {
        id: 'zero-indexer-testnet',
        label: 'ZeroIndexer Testnet',
        url: 'https://tee.testnet.unsafe.zec.rocks'
      }
    ]
  }
}
