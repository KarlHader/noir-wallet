export interface DappRegistryDocument {
  version: 1
  dapps: {
    id: string
    name: string
    category: string
    url: string
    iconUrl: string
  }[]
}

export const DAPP_REGISTRY: DappRegistryDocument = {
  version: 1,
  dapps: [
    {
      id: 'noir-lending',
      name: 'Noir',
      category: 'Lending',
      url: 'https://app.zknoir.com/lending',
      iconUrl: 'https://zknoir.com/favicon.ico'
    },
    {
      id: 'noir-perp',
      name: 'Noir',
      category: 'Perp',
      url: 'https://app.zknoir.com/perps',
      iconUrl: 'https://zknoir.com/favicon.ico'
    },
    {
      id: 'aave-lending',
      name: 'AAVE',
      category: 'Lending',
      url: 'https://app.aave.com',
      iconUrl: 'https://app.aave.com/favicon.ico'
    }
  ]
}
