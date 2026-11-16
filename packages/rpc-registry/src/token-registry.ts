export interface TokenRegistryAsset {
  assetId: string
  network: 'mainnet' | 'testnet'
  defaultVisible: boolean
}

export interface TokenRegistryDocument {
  version: 1
  updatedAt: string
  assets: TokenRegistryAsset[]
}

// Admit tokens by chain and contract identity, never by symbol, price, or an unverified provider list.
export const TOKEN_REGISTRY: TokenRegistryDocument = {
  version: 1,
  updatedAt: '2026-11-16T00:00:00.000Z',
  assets: [
    {
      assetId: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:10/erc20:0x0b2c639c533813f4aa9d7837caf62653d097ff85',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:43114/erc20:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId:
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'near:mainnet/nep141:usdt.tether-token.near',
      network: 'mainnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:11155111/erc20:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      network: 'testnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
      network: 'testnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      network: 'testnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:11155420/erc20:0x5fd84259d66cd46123540766be93dfe6d43130d7',
      network: 'testnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:80002/erc20:0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
      network: 'testnet',
      defaultVisible: true
    },
    {
      assetId: 'eip155:43113/erc20:0x5425890298aed601595a70ab815c96711a31bc65',
      network: 'testnet',
      defaultVisible: true
    }
  ]
}
