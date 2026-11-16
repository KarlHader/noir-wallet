import { expect, test } from '@playwright/test'

import { getSolanaNetworkConfigs, SOLANA_NETWORKS } from '../../../src/config/networks.ts'
import { readSolanaBalances } from '../../../src/infrastructure/chains/solana/solana-balance-reader.ts'
import { createSolanaActivityHistorySource } from '../../../src/infrastructure/chains/solana/solana-activity-history-source.ts'
import { attestSolanaRpcEndpoint } from '../../../src/infrastructure/chains/solana/solana-network-attestation.ts'
import { createSolanaRpcClient } from '../../../src/infrastructure/chains/solana/solana-rpc-client.ts'
import { resolveSolanaRpcEndpointOptions } from '../../../src/infrastructure/chains/managed-rpc-endpoints.ts'
import {
  fetchRpcRegistry,
  setActiveRpcRegistryDocument
} from '../../../src/infrastructure/chains/rpc-registry-client.ts'

test.describe('live trusted Solana RPC profiles', () => {
  test.skip(process.env.LIVE_SOLANA_RPC !== '1', 'Set LIVE_SOLANA_RPC=1 to enable')

  for (const network of getSolanaNetworkConfigs()) {
    test(`attests ${network.clusterName} against its full genesis hash`, async () => {
      const client = createSolanaRpcClient({
        chainId: network.chainId,
        rpcUrl: network.rpcUrl
      })

      await attestSolanaRpcEndpoint({ chainId: network.chainId, rpcUrl: network.rpcUrl })
      expect(await client.getBlockHeight()).toBeGreaterThan(0)
    })
  }

  test('attests managed Mainnet RPCs and reads live chain state', async () => {
    setActiveRpcRegistryDocument(await fetchRpcRegistry())
    for (const endpoint of resolveSolanaRpcEndpointOptions('mainnet')) {
      const client = createSolanaRpcClient({
        chainId: SOLANA_NETWORKS.mainnet.chainId,
        rpcUrl: endpoint.url
      })
      await attestSolanaRpcEndpoint({
        chainId: SOLANA_NETWORKS.mainnet.chainId,
        rpcUrl: endpoint.url
      })
      const [height, blockhash] = await Promise.all([
        client.getBlockHeight(),
        client.getLatestBlockhash()
      ])
      expect(height).toBeGreaterThan(0)
      expect(blockhash.lastValidBlockHeight).toBeGreaterThan(height)
    }
  })

  test('reads the Mainnet USDC ATA path without an indexed owner query', async () => {
    const client = createSolanaRpcClient({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      rpcUrl: SOLANA_NETWORKS.mainnet.rpcUrl
    })
    const result = await client.getTokenAccountsByMints(SOLANA_NETWORKS.mainnet.genesisHash, [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ])
    expect(result.contextSlot).toBeGreaterThan(0)
    expect(Array.isArray(result.accounts)).toBe(true)
  })

  test('reads an explicitly configured Mainnet owner token inventory', async () => {
    test.skip(!process.env.LIVE_SOLANA_OWNER, 'Set LIVE_SOLANA_OWNER to enable')
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const client = createSolanaRpcClient({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      rpcUrl: SOLANA_NETWORKS.mainnet.rpcUrl
    })
    const result = await readSolanaBalances({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      address: process.env.LIVE_SOLANA_OWNER,
      rpc: client,
      tokenMints: [usdcMint]
    })
    expect(result.native.contextSlot).toBeGreaterThan(0)
    expect(result.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: `${SOLANA_NETWORKS.mainnet.chainId}/token:${usdcMint}`,
          mint: usdcMint,
          amountRaw: expect.stringMatching(/^[1-9][0-9]*$/)
        })
      ])
    )
  })

  test('reads token-account history for an explicitly configured Mainnet owner', async () => {
    test.skip(!process.env.LIVE_SOLANA_OWNER, 'Set LIVE_SOLANA_OWNER to enable')
    test.skip(
      !process.env.LIVE_SOLANA_ORIGIN,
      'Set LIVE_SOLANA_ORIGIN to enable browser-origin RPC'
    )
    const client = createSolanaRpcClient(
      {
        chainId: SOLANA_NETWORKS.mainnet.chainId,
        rpcUrl: SOLANA_NETWORKS.mainnet.rpcUrl
      },
      (input, init) =>
        fetch(input, {
          ...init,
          headers: { ...init.headers, Origin: process.env.LIVE_SOLANA_ORIGIN }
        })
    )
    const source = createSolanaActivityHistorySource({
      chainId: SOLANA_NETWORKS.mainnet.chainId,
      rpc: client
    })
    const items = await source.readAddressActivity({
      scope: { keyDomainId: 'live-wallet', accountId: 'live-account' },
      address: process.env.LIVE_SOLANA_OWNER
    })
    expect(items.length).toBeGreaterThan(0)
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'rpc',
          segments: expect.arrayContaining([
            expect.objectContaining({
              target: expect.objectContaining({ chainId: SOLANA_NETWORKS.mainnet.chainId })
            })
          ])
        })
      ])
    )
  })

  test('reads devnet SOL and both supported SPL token programs', async () => {
    const client = createSolanaRpcClient({
      chainId: SOLANA_NETWORKS.devnet.chainId,
      rpcUrl: SOLANA_NETWORKS.devnet.rpcUrl
    })

    const probeAddress = SOLANA_NETWORKS.devnet.genesisHash
    const [balance, latestBlockhash, tokens] = await Promise.all([
      client.getBalance(probeAddress),
      client.getLatestBlockhash(),
      client.getTokenAccountsByMints(probeAddress, [probeAddress])
    ])
    expect(BigInt(balance)).toBeGreaterThanOrEqual(0n)
    expect(latestBlockhash.lastValidBlockHeight).toBeGreaterThan(0)
    expect(Array.isArray(tokens.accounts)).toBe(true)
  })
})
