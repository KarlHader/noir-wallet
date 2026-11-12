import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  addEvmNetwork,
  detectBitcoinProvider,
  detectDashProvider,
  detectEvmProvider,
  detectNearProvider,
  detectPearlProvider,
  detectQuantusProvider,
  detectSolanaProvider,
  getNoirWallet,
  switchEvmChain,
  type BitcoinBalance,
  type BitcoinChainInfo,
  type BitcoinNetwork,
  type BitcoinProvider,
  type Caip25Session,
  type DashBalance,
  type DashChainInfo,
  type DashNetwork,
  type DashProvider,
  type EvmProvider,
  type NearProvider,
  type PearlBalance,
  type PearlChainInfo,
  type PearlNetwork,
  type PearlProvider,
  type QuantusBalance,
  type QuantusChainInfo,
  type QuantusNetwork,
  type QuantusProvider,
  type SolanaProvider
} from '@noir-wallet/sdk'
import {
  encodeFunctionData,
  formatEther as formatEtherAmount,
  isAddress,
  parseEther as parseEtherAmount
} from 'viem'
import testContractDeployments from './evm-test-contracts.json'
import {
  getEvmNetworkExample,
  getEvmNetworkExamples,
  getExampleChainIconUrl,
  type EvmNetworkExample
} from './evm-network-catalog'
import { buildExampleMultichainSessionRequest } from './multichain-session-request'
import { createPearlTestPsbtHex } from './pearl-test-psbt'

const NOIR_TEST_BENCH_ABI = [
  {
    type: 'function',
    name: 'setValue',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'nextValue', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'increment',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'alwaysRevert',
    stateMutability: 'pure',
    inputs: [],
    outputs: []
  }
] as const

const TEST_BENCH_DEPLOYMENTS = testContractDeployments as Readonly<
  Record<string, { readonly NoirTestBench?: string }>
>

export type ExampleProviderId =
  | 'zcash'
  | 'evm'
  | 'bitcoin'
  | 'dash'
  | 'pearl'
  | 'quantus'
  | 'solana'
  | 'near'
  | 'starknet'

export interface ExampleNavigationProps {
  active: ExampleProviderId
  onChange: (provider: ExampleProviderId) => void
  networkMode: EvmNetworkExample['mode']
  onNetworkModeChange: (mode: EvmNetworkExample['mode']) => void
  selectedEvmNetwork: EvmNetworkExample
  evmSelectionVersion: number
  onSelectEvmNetwork: (network: EvmNetworkExample) => void
  onSyncEvmNetwork: (network: EvmNetworkExample) => void
}

export function ExampleChainIcon({
  iconUrl,
  label,
  className
}: {
  iconUrl: string
  label: string
  className: string
}) {
  return (
    <span className={`${className} example-chain-icon`} aria-hidden="true">
      <span>{label.slice(0, 1)}</span>
      <img
        src={iconUrl}
        alt=""
        onError={event => {
          event.currentTarget.hidden = true
        }}
      />
    </span>
  )
}

export function ProviderSwitcher({
  active,
  onChange,
  networkMode,
  onNetworkModeChange,
  selectedEvmNetwork,
  onSelectEvmNetwork
}: ExampleNavigationProps) {
  const [session, setSession] = useState<Caip25Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const wallet = getNoirWallet()
  const multichain = wallet?.multichain
  useEffect(() => {
    if (!multichain) return
    let active = true
    const applySession = (next: Caip25Session | null) => {
      if (active) setSession(next && Object.keys(next.scopes).length > 0 ? next : null)
    }
    const handleSessionChanged = (next: Caip25Session) => applySession(next)
    multichain.on('wallet_sessionChanged', handleSessionChanged)
    void multichain
      .getSession()
      .then(applySession)
      .catch(() => {})
    return () => {
      active = false
      multichain.removeListener('wallet_sessionChanged', handleSessionChanged)
    }
  }, [multichain])

  const createMultichainSession = async () => {
    if (!multichain || !wallet) return
    setSessionLoading(true)
    setSessionError(null)
    try {
      const next = await multichain.createSession(
        buildExampleMultichainSessionRequest(
          wallet,
          networkMode,
          selectedEvmNetwork.request.chainId
        )
      )
      setSession(next)
    } catch (error) {
      setSessionError(formatError(error))
    } finally {
      setSessionLoading(false)
    }
  }

  const revokeMultichainSession = async () => {
    if (!multichain) return
    setSessionLoading(true)
    setSessionError(null)
    try {
      await multichain.revokeSession()
      setSession(null)
    } catch (error) {
      setSessionError(formatError(error))
    } finally {
      setSessionLoading(false)
    }
  }

  const options = [
    {
      id: 'zcash' as const,
      label: 'Zcash',
      iconUrl: getExampleChainIconUrl('zcash')
    },
    ...getEvmNetworkExamples(networkMode).map(network => ({
      id: 'evm' as const,
      label: network.label,
      iconUrl: network.iconUrl,
      network
    })),
    { id: 'bitcoin' as const, label: 'Bitcoin', iconUrl: getExampleChainIconUrl('bitcoin') },
    { id: 'dash' as const, label: 'Dash', iconUrl: getExampleChainIconUrl('dash') },
    { id: 'pearl' as const, label: 'Pearl', iconUrl: getExampleChainIconUrl('pearl') },
    { id: 'quantus' as const, label: 'Quantus', iconUrl: getExampleChainIconUrl('quantus') },
    {
      id: 'solana' as const,
      label: networkMode === 'mainnet' ? 'Solana' : 'Solana Devnet',
      iconUrl: getExampleChainIconUrl('solana')
    },
    {
      id: 'near' as const,
      label: networkMode === 'mainnet' ? 'NEAR' : 'NEAR Testnet',
      iconUrl: getExampleChainIconUrl('near')
    },
    {
      id: 'starknet' as const,
      label: networkMode === 'mainnet' ? 'Starknet' : 'Starknet Sepolia',
      iconUrl: getExampleChainIconUrl('starknet')
    }
  ]
  return (
    <nav className="provider-network-nav" aria-label="Provider examples">
      <div className="multichain-session-bar">
        <div>
          <strong>CAIP-25 multichain session</strong>
          <span>
            {session
              ? `${Object.keys(session.scopes).length} networks authorized`
              : 'Connect once, then use every authorized provider.'}
          </span>
          {sessionError && <span className="multichain-session-error">{sessionError}</span>}
        </div>
        {session ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={sessionLoading}
            onClick={() => void revokeMultichainSession()}
          >
            Revoke session
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!multichain || sessionLoading}
            onClick={() => void createMultichainSession()}
          >
            {sessionLoading ? 'Connecting…' : 'Connect all networks'}
          </button>
        )}
      </div>
      <div className="provider-network-nav-heading">
        <div>
          <span className="section-kicker">Provider examples</span>
          <h2>Networks</h2>
        </div>
        <div className="network-mode-tabs" aria-label="Example network mode">
          {(['mainnet', 'testnet'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              className={networkMode === mode ? 'active' : ''}
              aria-pressed={networkMode === mode}
              onClick={() => onNetworkModeChange(mode)}
            >
              {mode === 'mainnet' ? 'Mainnet' : 'Testnet'}
            </button>
          ))}
        </div>
      </div>
      <div className="provider-network-grid">
        {options.map(option => {
          const selected =
            active === option.id && (option.id !== 'evm' || option.network === selectedEvmNetwork)
          return (
            <button
              key={option.id === 'evm' ? option.network.request.chainId : option.id}
              type="button"
              className={`provider-network-button ${selected ? 'active' : ''}`}
              aria-label={option.label}
              aria-pressed={selected}
              onClick={() => {
                if (option.id === 'evm') onSelectEvmNetwork(option.network)
                onChange(option.id)
              }}
            >
              <ExampleChainIcon
                className="provider-network-icon-frame"
                iconUrl={option.iconUrl}
                label={option.label}
              />
              <span>{option.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

export function ExampleLayout({
  navigation,
  available,
  connected,
  children
}: {
  navigation: ExampleNavigationProps
  available: boolean
  connected: boolean
  children: ReactNode
}) {
  const statusClass = !available ? 'unavailable' : connected ? 'connected' : 'ready'
  const statusLabel = !available
    ? 'Provider unavailable'
    : connected
      ? 'Connected'
      : 'Provider ready'

  return (
    <div className="app">
      <header className="header">
        <div className="header-content">
          <div className="logo">
            <a href="/" className="logo-link">
              <img
                src={`${import.meta.env.BASE_URL}logo.png`}
                alt="Noir Wallet"
                className="logo-img"
              />
              <span className="logo-text">
                <span className="logo-noir">Noir </span>
                <span className="logo-wallet">Wallet</span>
              </span>
            </a>
            <span className="logo-badge">SDK Example V2</span>
          </div>
          <span className={`status-badge ${statusClass}`}>{statusLabel}</span>
        </div>
      </header>
      <main className="main">
        <section className="page-intro">
          <div>
            <p className="eyebrow">Noir Wallet developer tools</p>
            <h1>Multichain SDK Playground</h1>
          </div>
        </section>
        <ProviderSwitcher {...navigation} />
        {children}
      </main>
      <footer className="footer">
        <p>Noir Wallet SDK Example V2</p>
      </footer>
    </div>
  )
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    const code = Reflect.get(error, 'code')
    return typeof code === 'number' ? `${code}: ${error.message}` : error.message
  }
  return 'The wallet request failed.'
}

function utf8ToHex(value: string): string {
  return `0x${Array.from(new TextEncoder().encode(value), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function parseEther(value: string): string {
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) {
    throw new Error('ETH amount must be a non-negative decimal with at most 18 decimal places.')
  }
  const wei = parseEtherAmount(normalized)
  if (wei <= 0n) throw new Error('ETH amount must be greater than zero.')
  return `0x${wei.toString(16)}`
}

function formatEther(hexWei: string): string {
  if (!/^0x[0-9a-f]+$/i.test(hexWei)) return hexWei
  return formatEtherAmount(BigInt(hexWei))
}

function Result({ label, value }: { label: string; value: string }) {
  return (
    <div className="result-item">
      <span className="label">{label}</span>
      <code className="result-code">{value}</code>
    </div>
  )
}

export function AuthorizedAccountsExample({
  accounts,
  busy,
  onReview
}: {
  accounts: readonly string[]
  busy: boolean
  onReview: () => void
}) {
  return (
    <section className="card card-compact">
      <h2>Batch account authorization</h2>
      <p className="card-hint">
        The current account is selected by default. Review the connection to authorize more wallets
        for this site.
      </p>
      {accounts.length === 0 ? (
        <p className="field-help">No accounts authorized.</p>
      ) : (
        <div className="batch-list">
          {accounts.map((address, index) => (
            <div className="batch-item" key={address}>
              <div className="batch-item-header">
                <span className="batch-label">
                  {index === 0 ? 'Current account' : `Account ${index + 1}`}
                </span>
              </div>
              <code className="result-code">{address}</code>
            </div>
          ))}
        </div>
      )}
      <button className="btn btn-secondary btn-full" disabled={busy} onClick={onReview}>
        Review authorized accounts
      </button>
    </section>
  )
}

export function EvmExample({ navigation }: { navigation: ExampleNavigationProps }) {
  const [provider, setProvider] = useState<EvmProvider | null>(
    () => getNoirWallet()?.ethereum ?? null
  )
  const [chainId, setChainId] = useState('')
  const [account, setAccount] = useState('')
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [balance, setBalance] = useState('')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('Hello Noir Wallet')
  const [contractAddress, setContractAddress] = useState('')
  const [contractValue, setContractValue] = useState('42')
  const [contractDeposit, setContractDeposit] = useState('0.0001')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [networkReady, setNetworkReady] = useState(false)
  const initialSelectionVersion = useRef(navigation.evmSelectionVersion)

  useEffect(() => {
    if (provider) return
    const controller = new AbortController()
    detectEvmProvider({ timeoutMs: 3000, signal: controller.signal })
      .then(setProvider)
      .catch(discoveryError => {
        if ((discoveryError as Error).name !== 'AbortError') setError(formatError(discoveryError))
      })
    return () => controller.abort()
  }, [provider])

  const refresh = useCallback(
    async (current: EvmProvider, syncNavigation = false) => {
      const [nextChainId, accounts] = await Promise.all([
        current.request<string>({ method: 'eth_chainId' }),
        current.request<readonly string[]>({ method: 'eth_accounts' })
      ])
      if (syncNavigation) {
        const selected = getEvmNetworkExample(nextChainId)
        if (selected) navigation.onSyncEvmNetwork(selected)
      }
      const nextAccount = accounts[0] ?? ''
      setAccounts(accounts)
      setChainId(nextChainId)
      setAccount(nextAccount)
      setNetworkReady(true)
      setContractAddress(value => {
        const preset = TEST_BENCH_DEPLOYMENTS[BigInt(nextChainId).toString()]?.NoirTestBench
        return preset ?? value
      })
      setBalance(
        nextAccount
          ? formatEther(
              await current.request<string>({
                method: 'eth_getBalance',
                params: [nextAccount, 'latest']
              })
            )
          : ''
      )
    },
    [navigation.onSyncEvmNetwork]
  )

  useEffect(() => {
    if (!provider) return
    const onAccountsChanged = (value: unknown) => {
      const accounts = Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
      setAccount(accounts[0] ?? '')
      setAccounts(accounts)
      void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    }
    const onChainChanged = (value: unknown) => {
      if (typeof value === 'string') setChainId(value)
      void refresh(provider, true).catch(refreshError => setError(formatError(refreshError)))
    }
    provider.on('accountsChanged', onAccountsChanged)
    provider.on('chainChanged', onChainChanged)
    void refresh(provider, initialSelectionVersion.current === 0).catch(refreshError =>
      setError(formatError(refreshError))
    )
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged)
      provider.removeListener('chainChanged', onChainChanged)
    }
  }, [provider, refresh])

  const run = async (operation: () => Promise<string | void>) => {
    setBusy(true)
    setError('')
    setResult('')
    try {
      const nextResult = await operation()
      if (nextResult) setResult(nextResult)
      if (provider) await refresh(provider)
    } catch (operationError) {
      setError(formatError(operationError))
    } finally {
      setBusy(false)
    }
  }

  const lastHandledSelectionVersion = useRef(0)
  useEffect(() => {
    const selectionVersion = navigation.evmSelectionVersion
    if (
      !provider ||
      !networkReady ||
      !chainId ||
      selectionVersion === 0 ||
      selectionVersion === lastHandledSelectionVersion.current
    ) {
      return
    }
    lastHandledSelectionVersion.current = selectionVersion
    const targetChainId = navigation.selectedEvmNetwork.request.chainId
    if (chainId === targetChainId) return
    void run(async () => {
      try {
        await switchEvmChain(provider, targetChainId)
      } catch (switchError) {
        const active = getEvmNetworkExample(chainId)
        if (active) navigation.onSyncEvmNetwork(active)
        throw switchError
      }
      return `Switched to ${navigation.selectedEvmNetwork.label}`
    })
  }, [
    chainId,
    navigation.evmSelectionVersion,
    navigation.selectedEvmNetwork,
    networkReady,
    provider
  ])

  const connect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet EVM provider is unavailable.')
      const accounts = await provider.request<readonly string[]>({ method: 'eth_requestAccounts' })
      if (!accounts[0]) throw new Error('No EVM account was authorized.')
      return `Connected ${accounts[0]}`
    })

  const disconnect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet EVM provider is unavailable.')
      await provider.request({
        method: 'wallet_revokePermissions',
        params: [{ eth_accounts: {} }]
      })
      return 'EVM permission revoked.'
    })

  const reviewAccounts = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet EVM provider is unavailable.')
      await provider.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }]
      })
      return 'EVM account authorization updated.'
    })

  const sendTransaction = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect an EVM account first.')
      const transactionHash = await provider.request<string>({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: recipient.trim(), value: parseEther(amount) }]
      })
      return `Transaction: ${transactionHash}`
    })
  }

  const signMessage = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect an EVM account first.')
      const signature = await provider.request<string>({
        method: 'personal_sign',
        params: [utf8ToHex(message), account]
      })
      return `Personal signature: ${signature}`
    })
  }

  const signTypedData = () =>
    run(async () => {
      if (!provider || !account || !chainId) throw new Error('Connect an EVM account first.')
      const payload = JSON.stringify({
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          Message: [{ name: 'contents', type: 'string' }]
        },
        primaryType: 'Message',
        domain: {
          name: 'Noir Wallet SDK Example',
          version: '1',
          chainId: Number(BigInt(chainId)),
          verifyingContract: account
        },
        message: { contents: message }
      })
      const signature = await provider.request<string>({
        method: 'eth_signTypedData_v4',
        params: [account, payload]
      })
      return `Typed-data signature: ${signature}`
    })

  const addSelectedNetwork = () =>
    run(async () => {
      if (!provider) throw new Error('Connect an EVM account first.')
      await addEvmNetwork(provider, navigation.selectedEvmNetwork.request)
      return `${navigation.selectedEvmNetwork.label} is already available in Noir Wallet.`
    })

  const callTestBench = (functionName: 'increment' | 'setValue' | 'deposit' | 'alwaysRevert') =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect an EVM account first.')
      const target = contractAddress.trim()
      if (!isAddress(target)) throw new Error('Enter a valid NoirTestBench contract address.')
      if (!/^\d+$/.test(contractValue)) throw new Error('Test value must be an unsigned integer.')
      const data = encodeFunctionData({
        abi: NOIR_TEST_BENCH_ABI,
        functionName,
        ...(functionName === 'setValue' ? { args: [BigInt(contractValue)] } : {})
      })
      const transactionHash = await provider.request<string>({
        method: 'eth_sendTransaction',
        params: [
          {
            from: account,
            to: target,
            value: functionName === 'deposit' ? parseEther(contractDeposit) : '0x0',
            data
          }
        ]
      })
      return `${functionName} transaction: ${transactionHash}`
    })

  return (
    <ExampleLayout navigation={navigation} available={provider !== null} connected={account !== ''}>
      {!provider && <div className="message warning">EVM provider is not enabled.</div>}
      <section className="provider-summary card">
        <div className="provider-summary-copy">
          <ExampleChainIcon
            className="provider-hero-icon"
            iconUrl={navigation.selectedEvmNetwork.iconUrl}
            label={navigation.selectedEvmNetwork.label}
          />
          <div>
            <p className="section-kicker">Selected provider</p>
            <h2>EVM provider</h2>
            <p>Discovered through EIP-6963 without replacing another wallet provider.</p>
          </div>
        </div>
        <div className="provider-actions">
          <button
            className="btn btn-primary"
            onClick={() => void connect()}
            disabled={!provider || busy}
          >
            {account ? 'Reconnect EVM' : 'Connect EVM'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void disconnect()}
            disabled={!account || busy}
          >
            Disconnect
          </button>
        </div>
      </section>
      <div className="tab-panel grid-2">
        <section className="card card-compact">
          <h2>Account &amp; network</h2>
          <Result label="Chain ID" value={chainId || 'Unavailable'} />
          <Result label="Address" value={account || 'Not connected'} />
          <Result
            label="Native balance"
            value={balance ? `${balance} native units` : 'Unavailable'}
          />
          <details className="network-method-example">
            <summary>EIP-3085 add-network example</summary>
            <p>
              Noir Wallet accepts released built-in chains here. Custom EVM networks stay disabled
              in this release.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-full"
              onClick={() => void addSelectedNetwork()}
              disabled={!account || busy}
            >
              Add {navigation.selectedEvmNetwork.label}
            </button>
          </details>
        </section>
        <AuthorizedAccountsExample
          accounts={accounts}
          busy={busy}
          onReview={() => void reviewAccounts()}
        />
        <section className="card card-compact">
          <h2>Send native asset</h2>
          <form className="form-stack" onSubmit={sendTransaction}>
            <label className="label" htmlFor="evm-recipient">
              Recipient
            </label>
            <input
              id="evm-recipient"
              className="input input-sm"
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="0x…"
              required
            />
            <label className="label" htmlFor="evm-amount">
              Amount (native token)
            </label>
            <input
              id="evm-amount"
              className="input input-sm"
              value={amount}
              onChange={event => setAmount(event.target.value)}
              placeholder="0.001"
              inputMode="decimal"
              required
            />
            <button className="btn btn-primary btn-full" disabled={!account || busy}>
              Send transaction
            </button>
          </form>
        </section>
        <section className="card card-compact grid-span-2">
          <h2>Smart contract testing</h2>
          <p className="card-hint">
            Exercises arbitrary calldata, payable value, simulation rejection, approval, signing,
            broadcast, and Activity through the real EIP-1193 provider.
          </p>
          <div className="form-stack">
            <label className="label" htmlFor="evm-contract-address">
              NoirTestBench address
            </label>
            <input
              id="evm-contract-address"
              className="input input-sm"
              value={contractAddress}
              onChange={event => setContractAddress(event.target.value)}
              placeholder="0x…"
            />
            <div className="contract-fields">
              <div className="form-group">
                <label className="label" htmlFor="evm-contract-value">
                  setValue argument
                </label>
                <input
                  id="evm-contract-value"
                  className="input input-sm"
                  value={contractValue}
                  onChange={event => setContractValue(event.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div className="form-group">
                <label className="label" htmlFor="evm-contract-deposit">
                  Deposit amount
                </label>
                <input
                  id="evm-contract-deposit"
                  className="input input-sm"
                  value={contractDeposit}
                  onChange={event => setContractDeposit(event.target.value)}
                  inputMode="decimal"
                />
              </div>
            </div>
            <div className="contract-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void callTestBench('increment')}
                disabled={!account || busy}
              >
                Increment
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void callTestBench('setValue')}
                disabled={!account || busy}
              >
                Set value
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void callTestBench('deposit')}
                disabled={!account || busy}
              >
                Payable deposit
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void callTestBench('alwaysRevert')}
                disabled={!account || busy}
              >
                Verify revert block
              </button>
            </div>
          </div>
        </section>
        <section className="card card-compact grid-span-2">
          <h2>Sign messages</h2>
          <form className="form-stack" onSubmit={signMessage}>
            <label className="label" htmlFor="evm-message">
              Message
            </label>
            <textarea
              id="evm-message"
              className="input textarea"
              value={message}
              onChange={event => setMessage(event.target.value)}
              rows={3}
              required
            />
            <div className="btn-row">
              <button className="btn btn-primary" disabled={!account || busy}>
                Personal sign
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void signTypedData()}
                disabled={!account || busy}
              >
                Sign EIP-712
              </button>
            </div>
          </form>
        </section>
      </div>
      {result && <div className="message success provider-result">{result}</div>}
      {error && <div className="message error provider-result">{error}</div>}
    </ExampleLayout>
  )
}

export function BitcoinExample({ navigation }: { navigation: ExampleNavigationProps }) {
  const [provider, setProvider] = useState<BitcoinProvider | null>(
    () => getNoirWallet()?.bitcoin ?? null
  )
  const [network, setNetwork] = useState<BitcoinNetwork | ''>('')
  const [chain, setChain] = useState<BitcoinChainInfo | null>(null)
  const [account, setAccount] = useState('')
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [publicKey, setPublicKey] = useState('')
  const [balance, setBalance] = useState<BitcoinBalance | null>(null)
  const [recipient, setRecipient] = useState('')
  const [satoshis, setSatoshis] = useState('')
  const [feeRate, setFeeRate] = useState('')
  const [message, setMessage] = useState('Hello Noir Bitcoin')
  const [psbt, setPsbt] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (provider) return
    const controller = new AbortController()
    detectBitcoinProvider({ timeoutMs: 3000, signal: controller.signal })
      .then(setProvider)
      .catch(discoveryError => {
        if ((discoveryError as Error).name !== 'AbortError') setError(formatError(discoveryError))
      })
    return () => controller.abort()
  }, [provider])

  const refresh = useCallback(async (current: BitcoinProvider) => {
    const [nextNetwork, nextChain, accounts] = await Promise.all([
      current.getNetwork(),
      current.getChain(),
      current.getAccounts()
    ])
    const nextAccount = accounts[0] ?? ''
    setAccounts(accounts)
    setNetwork(nextNetwork)
    setChain(nextChain)
    setAccount(nextAccount)
    if (!nextAccount) {
      setPublicKey('')
      setBalance(null)
      return
    }
    const [nextPublicKey, nextBalance] = await Promise.all([
      current.getPublicKey(),
      current.getBalance()
    ])
    setPublicKey(nextPublicKey)
    setBalance(nextBalance)
  }, [])

  useEffect(() => {
    if (!provider) return
    const onAccountsChanged = () => {
      void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    }
    provider.on('accountsChanged', onAccountsChanged)
    void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged)
    }
  }, [provider, refresh])

  const run = async (operation: () => Promise<string | void>) => {
    setBusy(true)
    setError('')
    setResult('')
    try {
      const nextResult = await operation()
      if (nextResult) setResult(nextResult)
      if (provider) await refresh(provider)
    } catch (operationError) {
      setError(formatError(operationError))
    } finally {
      setBusy(false)
    }
  }

  const connect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Bitcoin provider is unavailable.')
      const connected = await provider.connect()
      setPublicKey(connected.publicKey)
      return `Connected ${connected.address}`
    })

  const disconnect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Bitcoin provider is unavailable.')
      await provider.disconnect()
      return 'Bitcoin permission revoked.'
    })

  const validateNetwork = () =>
    run(async () => {
      if (!provider || !network) throw new Error('Connect a Bitcoin account first.')
      await provider.switchNetwork(network)
      return `${network} matches Noir Wallet global mode.`
    })

  const validateChain = () =>
    run(async () => {
      if (!provider || !chain) throw new Error('Connect a Bitcoin account first.')
      await provider.switchChain({ enum: chain.enum })
      return `${chain.name} matches Noir Wallet global mode.`
    })

  const sendBitcoin = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect a Bitcoin account first.')
      if (!/^\d+$/.test(satoshis)) throw new Error('Satoshis must be a positive integer.')
      const amount = Number(satoshis)
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error('Satoshis must be a positive safe integer.')
      }
      const parsedFeeRate = feeRate === '' ? undefined : Number(feeRate)
      if (
        parsedFeeRate !== undefined &&
        (!Number.isSafeInteger(parsedFeeRate) || parsedFeeRate <= 0)
      ) {
        throw new Error('Fee rate must be a positive integer in sat/vB.')
      }
      const transactionId = await provider.sendBitcoin(
        recipient.trim(),
        amount,
        parsedFeeRate === undefined ? undefined : { feeRate: parsedFeeRate }
      )
      return `Transaction: ${transactionId}`
    })
  }

  const signMessage = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect a Bitcoin account first.')
      return `BIP-322 signature: ${await provider.signMessage(message, 'bip322-simple')}`
    })
  }

  const signPsbt = () =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect a Bitcoin account first.')
      if (!/^(?:[0-9a-f]{2})+$/i.test(psbt.trim())) throw new Error('Enter a PSBT as hex bytes.')
      return `Signed PSBT: ${await provider.signPsbt(psbt.trim(), { autoFinalized: false })}`
    })

  const pushPsbt = () =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect a Bitcoin account first.')
      if (!/^(?:[0-9a-f]{2})+$/i.test(psbt.trim())) throw new Error('Enter a PSBT as hex bytes.')
      return `Broadcast transaction: ${await provider.pushPsbt(psbt.trim())}`
    })

  return (
    <ExampleLayout navigation={navigation} available={provider !== null} connected={account !== ''}>
      {!provider && <div className="message warning">Bitcoin provider is not enabled.</div>}
      <section className="provider-summary card">
        <div className="provider-summary-copy">
          <ExampleChainIcon
            className="provider-hero-icon"
            iconUrl={getExampleChainIconUrl('bitcoin')}
            label="Bitcoin"
          />
          <div>
            <p className="section-kicker">Selected provider</p>
            <h2>Bitcoin provider</h2>
            <p>Typed access to accounts, BIP-322 signatures, PSBTs, and transactions.</p>
          </div>
        </div>
        <div className="provider-actions">
          <button
            className="btn btn-primary"
            onClick={() => void connect()}
            disabled={!provider || busy}
          >
            {account ? 'Reconnect Bitcoin' : 'Connect Bitcoin'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void disconnect()}
            disabled={!account || busy}
          >
            Disconnect
          </button>
        </div>
      </section>
      <div className="tab-panel grid-2">
        <section className="card card-compact">
          <h2>Account &amp; network</h2>
          <Result label="Network" value={network || 'Unavailable'} />
          <Result label="Chain" value={chain?.name ?? 'Unavailable'} />
          <Result label="Address" value={account || 'Not connected'} />
          <Result label="Public key" value={publicKey || 'Unavailable'} />
          <Result
            label="Balance"
            value={
              balance ? `${balance.total} sats (${balance.unconfirmed} unconfirmed)` : 'Unavailable'
            }
          />
          <div className="button-row compact-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void validateNetwork()}
              disabled={!account || busy}
            >
              Validate network
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void validateChain()}
              disabled={!account || busy}
            >
              Validate chain
            </button>
          </div>
          <p className="field-help">
            These compatibility methods validate the active mode. Change Mainnet/Testnet Mode in
            Noir Wallet settings.
          </p>
        </section>
        <AuthorizedAccountsExample
          accounts={accounts}
          busy={busy}
          onReview={() => void connect()}
        />
        <section className="card card-compact">
          <h2>Send Bitcoin</h2>
          <form className="form-stack" onSubmit={sendBitcoin}>
            <label className="label" htmlFor="bitcoin-recipient">
              Recipient
            </label>
            <input
              id="bitcoin-recipient"
              className="input input-sm"
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="bc1q… / tb1q…"
              required
            />
            <label className="label" htmlFor="bitcoin-fee-rate">
              Fee rate (sat/vB, optional)
            </label>
            <input
              id="bitcoin-fee-rate"
              className="input input-sm"
              value={feeRate}
              onChange={event => setFeeRate(event.target.value)}
              inputMode="numeric"
              placeholder="Wallet estimate"
            />
            <label className="label" htmlFor="bitcoin-satoshis">
              Amount (satoshis)
            </label>
            <input
              id="bitcoin-satoshis"
              className="input input-sm"
              value={satoshis}
              onChange={event => setSatoshis(event.target.value)}
              inputMode="numeric"
              placeholder="1000"
              required
            />
            <button className="btn btn-primary btn-full" disabled={!account || busy}>
              Send Bitcoin
            </button>
          </form>
        </section>
        <section className="card card-compact">
          <h2>Sign BIP-322 message</h2>
          <form className="form-stack" onSubmit={signMessage}>
            <textarea
              className="input textarea"
              value={message}
              onChange={event => setMessage(event.target.value)}
              rows={3}
              required
            />
            <button className="btn btn-primary btn-full" disabled={!account || busy}>
              Sign message
            </button>
          </form>
        </section>
        <section className="card card-compact">
          <h2>Sign PSBT</h2>
          <textarea
            className="input textarea"
            value={psbt}
            onChange={event => setPsbt(event.target.value)}
            rows={4}
            placeholder="PSBT hex"
          />
          <button
            className="btn btn-secondary btn-full"
            onClick={() => void signPsbt()}
            disabled={!account || !psbt || busy}
          >
            Sign PSBT
          </button>
          <button
            className="btn btn-secondary btn-full"
            onClick={() => void pushPsbt()}
            disabled={!account || !psbt || busy}
          >
            Broadcast PSBT
          </button>
        </section>
      </div>
      {result && <div className="message success provider-result">{result}</div>}
      {error && <div className="message error provider-result">{error}</div>}
    </ExampleLayout>
  )
}

function formatDashError(error: unknown): string {
  if (error instanceof Error && error.message) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'number' ? `${error.message} (${code})` : error.message
  }
  return formatError(error)
}

export function DashExample({ navigation }: { navigation: ExampleNavigationProps }) {
  const [provider, setProvider] = useState<DashProvider | null>(() => getNoirWallet()?.dash ?? null)
  const [network, setNetwork] = useState<DashNetwork | ''>('')
  const [chain, setChain] = useState<DashChainInfo | null>(null)
  const [account, setAccount] = useState('')
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [publicKey, setPublicKey] = useState('')
  const [balance, setBalance] = useState<DashBalance | null>(null)
  const [recipient, setRecipient] = useState('')
  const [duffs, setDuffs] = useState('')
  const [message, setMessage] = useState('Hello Noir Dash')
  const [psbt, setPsbt] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (provider) return
    const controller = new AbortController()
    detectDashProvider({ timeoutMs: 3000, signal: controller.signal })
      .then(setProvider)
      .catch(discoveryError => {
        if ((discoveryError as Error).name !== 'AbortError')
          setError(formatDashError(discoveryError))
      })
    return () => controller.abort()
  }, [provider])

  const refresh = useCallback(async (current: DashProvider) => {
    const [nextNetwork, nextChain, authorized] = await Promise.all([
      current.getNetwork(),
      current.getChain(),
      current.getAccounts()
    ])
    const nextAccount = authorized[0] ?? ''
    setAccounts(authorized)
    setNetwork(nextNetwork)
    setChain(nextChain)
    setAccount(nextAccount)
    if (!nextAccount) {
      setPublicKey('')
      setBalance(null)
      return
    }
    setPublicKey(await current.getPublicKey())
    try {
      setBalance(await current.getBalance())
      setError('')
    } catch (balanceError) {
      setBalance(null)
      setError(formatDashError(balanceError))
    }
  }, [])

  useEffect(() => {
    if (!provider) return
    const onAccountsChanged = () => {
      void refresh(provider).catch(refreshError => setError(formatDashError(refreshError)))
    }
    provider.on('accountsChanged', onAccountsChanged)
    void refresh(provider).catch(refreshError => setError(formatDashError(refreshError)))
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged)
    }
  }, [provider, refresh])

  const run = async (operation: () => Promise<string | void>) => {
    setBusy(true)
    setError('')
    setResult('')
    try {
      const nextResult = await operation()
      if (nextResult) setResult(nextResult)
      if (provider) await refresh(provider)
    } catch (operationError) {
      setError(formatDashError(operationError))
    } finally {
      setBusy(false)
    }
  }

  const connect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Dash provider is unavailable.')
      const connected = await provider.connect()
      setAccount(connected.address)
      setPublicKey(connected.publicKey)
      return `Connected ${connected.address}`
    })

  const disconnect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Dash provider is unavailable.')
      await provider.disconnect()
      return 'Dash permission revoked.'
    })

  const refreshAccount = () => {
    if (!provider || busy) return
    setBusy(true)
    setError('')
    void refresh(provider)
      .catch(refreshError => setError(formatDashError(refreshError)))
      .finally(() => setBusy(false))
  }

  const sendDash = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect a Dash account first.')
      if (!/^(?:0|[1-9][0-9]*)$/.test(duffs) || duffs === '0') {
        throw new Error('Duffs must be a positive integer with no decimal point.')
      }
      const transactionId = await provider.sendDash(recipient.trim(), duffs as `${bigint}`)
      return `Transaction: ${transactionId}`
    })
  }

  const signMessage = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect a Dash account first.')
      return `Signature: ${await provider.signMessage(message)}`
    })
  }

  const signPsbt = () =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect a Dash account first.')
      if (!/^(?:[0-9a-f]{2})+$/i.test(psbt.trim())) throw new Error('Enter a PSBT as hex bytes.')
      return `Signed PSBT: ${await provider.signPsbt(psbt.trim())}`
    })

  const pushPsbt = () =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect a Dash account first.')
      if (!/^(?:[0-9a-f]{2})+$/i.test(psbt.trim())) throw new Error('Enter a PSBT as hex bytes.')
      return `Broadcast transaction: ${await provider.pushPsbt(psbt.trim())}`
    })

  return (
    <ExampleLayout navigation={navigation} available={provider !== null} connected={account !== ''}>
      {!provider && <div className="message warning">Dash provider is not enabled.</div>}
      <section className="provider-summary card">
        <div className="provider-summary-copy">
          <ExampleChainIcon
            className="provider-hero-icon"
            iconUrl={getExampleChainIconUrl('dash')}
            label="Dash"
          />
          <div>
            <p className="section-kicker">Selected provider</p>
            <h2>Dash provider</h2>
            <p>Typed access to accounts, messages, PSBTs, and transactions.</p>
          </div>
        </div>
        <div className="provider-actions">
          <button
            className="btn btn-primary"
            onClick={() => void connect()}
            disabled={!provider || busy}
          >
            {account ? 'Reconnect Dash' : 'Connect Dash'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void disconnect()}
            disabled={!account || busy}
          >
            Disconnect
          </button>
          <button
            className="btn btn-secondary"
            onClick={refreshAccount}
            disabled={!provider || busy}
          >
            Refresh account
          </button>
        </div>
      </section>
      <div className="tab-panel grid-2">
        <section className="card card-compact">
          <h2>Account &amp; network</h2>
          <Result label="Network" value={network || 'Unavailable'} />
          <Result label="Chain ID" value={chain?.chainId ?? 'Unavailable'} />
          <Result label="Chain" value={chain?.name ?? 'Unavailable'} />
          <Result label="Address" value={account || 'Not connected'} />
          <Result label="Public key" value={publicKey || 'Unavailable'} />
          <Result
            label="Balance"
            value={
              balance
                ? `${balance.total} duffs (${balance.unconfirmed} unconfirmed)`
                : 'Unavailable'
            }
          />
        </section>
        <AuthorizedAccountsExample
          accounts={accounts}
          busy={busy}
          onReview={() => void connect()}
        />
        <section className="card card-compact">
          <h2>Send Dash</h2>
          <form className="form-stack" onSubmit={sendDash}>
            <label className="label" htmlFor="dash-recipient">
              Recipient
            </label>
            <input
              id="dash-recipient"
              className="input input-sm"
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="X… / y…"
              required
            />
            <label className="label" htmlFor="dash-duffs">
              Amount (duffs)
            </label>
            <input
              id="dash-duffs"
              className="input input-sm"
              value={duffs}
              onChange={event => setDuffs(event.target.value)}
              inputMode="numeric"
              placeholder="100000000"
              required
            />
            <p className="field-help">Integer duffs only. The wallet estimates the fee.</p>
            <button className="btn btn-primary btn-full" disabled={!account || busy}>
              Send Dash
            </button>
          </form>
        </section>
        <section className="card card-compact">
          <h2>Sign message</h2>
          <form className="form-stack" onSubmit={signMessage}>
            <textarea
              className="input textarea"
              value={message}
              onChange={event => setMessage(event.target.value)}
              rows={3}
              required
            />
            <button className="btn btn-primary btn-full" disabled={!account || busy}>
              Sign message
            </button>
          </form>
        </section>
        <section className="card card-compact">
          <h2>Sign PSBT</h2>
          <p className="field-help">
            A PSBT is an unfinished transaction. It must start with 70736274ff and spend an unspent
            output owned by this account.
          </p>
          <textarea
            className="input textarea"
            value={psbt}
            onChange={event => setPsbt(event.target.value)}
            rows={4}
            placeholder="PSBT hex"
          />
          <button
            className="btn btn-secondary btn-full"
            onClick={() => void signPsbt()}
            disabled={!account || !psbt || busy}
          >
            Sign PSBT
          </button>
          <button
            className="btn btn-secondary btn-full"
            onClick={() => void pushPsbt()}
            disabled={!account || !psbt || busy}
          >
            Broadcast PSBT
          </button>
        </section>
      </div>
      {result && <div className="message success provider-result">{result}</div>}
      {error && <div className="message error provider-result">{error}</div>}
    </ExampleLayout>
  )
}

export function PearlExample({ navigation }: { navigation: ExampleNavigationProps }) {
  const [provider, setProvider] = useState<PearlProvider | null>(
    () => getNoirWallet()?.pearl ?? null
  )
  const [network, setNetwork] = useState<PearlNetwork | ''>('')
  const [chain, setChain] = useState<PearlChainInfo | null>(null)
  const [account, setAccount] = useState('')
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [publicKey, setPublicKey] = useState('')
  const [balance, setBalance] = useState<PearlBalance | null>(null)
  const [recipient, setRecipient] = useState('')
  const [satoshis, setSatoshis] = useState('1000')
  const [feeRate, setFeeRate] = useState('')
  const [message, setMessage] = useState('Hello Noir Pearl')
  const [psbt, setPsbt] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (provider) return
    const controller = new AbortController()
    detectPearlProvider({ timeoutMs: 3000, signal: controller.signal })
      .then(setProvider)
      .catch(discoveryError => {
        if ((discoveryError as Error).name !== 'AbortError') setError(formatError(discoveryError))
      })
    return () => controller.abort()
  }, [provider])

  const refresh = useCallback(async (current: PearlProvider) => {
    const [nextNetwork, nextChain, authorized] = await Promise.all([
      current.getNetwork(),
      current.getChain(),
      current.getAccounts()
    ])
    const nextAccount = authorized[0] ?? ''
    setAccounts(authorized)
    setNetwork(nextNetwork)
    setChain(nextChain)
    setAccount(nextAccount)
    if (!nextAccount) {
      setPublicKey('')
      setBalance(null)
      return
    }
    const [nextPublicKey, nextBalance] = await Promise.all([
      current.getPublicKey(),
      current.getBalance()
    ])
    setPublicKey(nextPublicKey)
    setBalance(nextBalance)
  }, [])

  useEffect(() => {
    if (!provider) return
    const onAccountsChanged = () => {
      void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    }
    provider.on('accountsChanged', onAccountsChanged)
    void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged)
    }
  }, [provider, refresh])

  const run = async (operation: () => Promise<string | void>) => {
    setBusy(true)
    setError('')
    setResult('')
    try {
      const nextResult = await operation()
      if (nextResult) setResult(nextResult)
      if (provider) await refresh(provider)
    } catch (operationError) {
      setError(formatError(operationError))
    } finally {
      setBusy(false)
    }
  }

  const connect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Pearl provider is unavailable.')
      const connected = await provider.connect()
      setPublicKey(connected.publicKey)
      return `Connected ${connected.address}`
    })

  const disconnect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Pearl provider is unavailable.')
      await provider.disconnect()
      return 'Pearl permission revoked.'
    })

  const validateNetwork = () =>
    run(async () => {
      if (!provider || !network) throw new Error('Connect a Pearl account first.')
      await provider.switchNetwork(network)
      return `${network} matches Noir Wallet global mode.`
    })

  const validateChain = () =>
    run(async () => {
      if (!provider || !chain) throw new Error('Connect a Pearl account first.')
      await provider.switchChain({ enum: chain.enum })
      return `${chain.name} matches Noir Wallet global mode.`
    })

  const sendPearl = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect a Pearl account first.')
      if (!/^\d+$/.test(satoshis)) throw new Error('Satoshis must be a positive integer.')
      const amount = Number(satoshis)
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error('Satoshis must be a positive safe integer.')
      }
      if (amount < 330) {
        throw new Error('Amount must be at least 330 satoshis (Pearl P2TR dust limit).')
      }
      const parsedFeeRate = feeRate === '' ? undefined : Number(feeRate)
      if (
        parsedFeeRate !== undefined &&
        (!Number.isSafeInteger(parsedFeeRate) || parsedFeeRate <= 0)
      ) {
        throw new Error('Fee rate must be a positive integer in sat/vB.')
      }
      const transactionId = await provider.sendPearl(
        recipient.trim(),
        amount,
        parsedFeeRate === undefined ? undefined : { feeRate: parsedFeeRate }
      )
      return `Transaction: ${transactionId}`
    })
  }

  const signMessage = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || !account) throw new Error('Connect a Pearl account first.')
      return `BIP-322 signature: ${await provider.signMessage(message, 'bip322-simple')}`
    })
  }

  const createTestPsbt = () =>
    run(async () => {
      if (!provider || !account || !network || !publicKey) {
        throw new Error('Connect a Pearl account first.')
      }
      if (!/^\d+$/.test(satoshis)) throw new Error('Satoshis must be a positive integer.')
      const amount = Number(satoshis)
      if (!Number.isSafeInteger(amount) || amount < 330) {
        throw new Error('Amount must be at least 330 satoshis (Pearl P2TR dust limit).')
      }
      const parsedFeeRate = feeRate === '' ? undefined : Number(feeRate)
      if (
        parsedFeeRate !== undefined &&
        (!Number.isSafeInteger(parsedFeeRate) || parsedFeeRate <= 0)
      ) {
        throw new Error('Fee rate must be a positive integer in sat/vB.')
      }
      const nextPsbt = await createPearlTestPsbtHex({
        network,
        account,
        publicKey,
        recipient: recipient.trim() || account,
        amountSats: amount,
        ...(parsedFeeRate === undefined ? {} : { feeRateSatsPerVbyte: parsedFeeRate })
      })
      setPsbt(nextPsbt)
      return `Draft PSBT ready (${nextPsbt.length / 2} bytes). Sign PSBT, then Broadcast PSBT.`
    })

  const signPsbt = () =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect a Pearl account first.')
      if (!/^(?:[0-9a-f]{2})+$/i.test(psbt.trim())) throw new Error('Enter a PSBT as hex bytes.')
      // Default autoFinalized=true so Broadcast can extract without re-finalizing.
      const signed = await provider.signPsbt(psbt.trim())
      setPsbt(signed)
      return `Signed PSBT ready. Click Broadcast PSBT to submit it.`
    })

  const pushPsbt = () =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect a Pearl account first.')
      if (!/^(?:[0-9a-f]{2})+$/i.test(psbt.trim())) throw new Error('Enter a PSBT as hex bytes.')
      const transactionId = await provider.pushPsbt(psbt.trim())
      return `Broadcast transaction: ${transactionId}`
    })

  return (
    <ExampleLayout navigation={navigation} available={provider !== null} connected={account !== ''}>
      {!provider && <div className="message warning">Pearl provider is not enabled.</div>}
      <section className="provider-summary card">
        <div className="provider-summary-copy">
          <ExampleChainIcon
            className="provider-hero-icon"
            iconUrl={getExampleChainIconUrl('pearl')}
            label="Pearl"
          />
          <div>
            <p className="section-kicker">Selected provider</p>
            <h2>Pearl provider</h2>
            <p>Typed access to accounts, BIP-322 signatures, PSBTs, and transactions.</p>
          </div>
        </div>
        <div className="provider-actions">
          <button
            className="btn btn-primary"
            onClick={() => void connect()}
            disabled={!provider || busy}
          >
            {busy ? 'Connecting…' : account ? 'Reconnect Pearl' : 'Connect Pearl'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void disconnect()}
            disabled={!account || busy}
          >
            Disconnect
          </button>
        </div>
      </section>
      {result && <div className="message success provider-result">{result}</div>}
      {error && <div className="message error provider-result">{error}</div>}
      <div className="tab-panel grid-2">
        <section className="card card-compact">
          <h2>Account &amp; network</h2>
          <Result label="Network" value={network || 'Unavailable'} />
          <Result label="Chain" value={chain?.name ?? 'Unavailable'} />
          <Result label="Address" value={account || 'Not connected'} />
          <Result label="Public key" value={publicKey || 'Unavailable'} />
          <Result
            label="Balance"
            value={
              balance ? `${balance.total} sats (${balance.unconfirmed} unconfirmed)` : 'Unavailable'
            }
          />
          <div className="button-row compact-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void validateNetwork()}
              disabled={!account || busy}
            >
              Validate network
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void validateChain()}
              disabled={!account || busy}
            >
              Validate chain
            </button>
          </div>
          <p className="field-help">
            These compatibility methods validate the active mode. Change Mainnet/Testnet Mode in
            Noir Wallet settings.
          </p>
        </section>
        <AuthorizedAccountsExample
          accounts={accounts}
          busy={busy}
          onReview={() => void connect()}
        />
        <section className="card card-compact">
          <h2>Send Pearl</h2>
          <form className="form-stack" onSubmit={sendPearl}>
            <label className="label" htmlFor="pearl-recipient">
              Recipient
            </label>
            <input
              id="pearl-recipient"
              className="input input-sm"
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="prl1… / tprl1…"
              required
            />
            <label className="label" htmlFor="pearl-fee-rate">
              Fee rate (sat/vB, optional)
            </label>
            <input
              id="pearl-fee-rate"
              className="input input-sm"
              value={feeRate}
              onChange={event => setFeeRate(event.target.value)}
              inputMode="numeric"
              placeholder="Wallet estimate"
            />
            <label className="label" htmlFor="pearl-satoshis">
              Amount (satoshis)
            </label>
            <input
              id="pearl-satoshis"
              className="input input-sm"
              value={satoshis}
              onChange={event => setSatoshis(event.target.value)}
              inputMode="numeric"
              placeholder="1000"
              required
            />
            <p className="field-help">
              Minimum 330 satoshis. Amount is in satoshis, not whole PRL.
            </p>
            <button className="btn btn-primary btn-full" disabled={!account || busy} type="submit">
              {busy ? 'Sending…' : 'Send Pearl'}
            </button>
            {error && <div className="message error provider-result">{error}</div>}
            {result && <div className="message success provider-result">{result}</div>}
          </form>
        </section>
        <section className="card card-compact">
          <h2>Sign BIP-322 message</h2>
          <form className="form-stack" onSubmit={signMessage}>
            <textarea
              className="input textarea"
              value={message}
              onChange={event => setMessage(event.target.value)}
              rows={3}
              required
            />
            <button className="btn btn-primary btn-full" disabled={!account || busy}>
              Sign message
            </button>
          </form>
        </section>
        <section className="card card-compact">
          <h2>Sign / Broadcast PSBT</h2>
          <p className="field-help">
            Uses Send Pearl recipient/amount/fee rate. Create draft → Sign PSBT (approve) →
            Broadcast PSBT.
          </p>
          <textarea
            className="input textarea"
            value={psbt}
            onChange={event => setPsbt(event.target.value)}
            rows={4}
            placeholder="PSBT hex"
          />
          <button
            className="btn btn-secondary btn-full"
            onClick={() => void createTestPsbt()}
            disabled={!account || !network || !publicKey || busy}
          >
            Create test PSBT
          </button>
          <button
            className="btn btn-secondary btn-full"
            onClick={() => void signPsbt()}
            disabled={!account || !psbt || busy}
          >
            Sign PSBT
          </button>
          <button
            className="btn btn-secondary btn-full"
            onClick={() => void pushPsbt()}
            disabled={!account || !psbt || busy}
          >
            Broadcast PSBT
          </button>
        </section>
      </div>
    </ExampleLayout>
  )
}

function formatQuantusUnits(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return raw
  const base = 10n ** BigInt(decimals)
  const value = BigInt(raw)
  const whole = value / base
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`
}

function shortenPublicKey(value: string): string {
  if (value.length <= 48) return value
  return `${value.slice(0, 32)}…${value.slice(-8)} (${value.length} hex chars)`
}

/**
 * Quantus dApp example: accounts, network/chain reads, balances, a reviewed
 * native QTC/PLK send, and `author_submitExtrinsic` broadcast of bytes signed
 * elsewhere. Message and generic-call signing are not exposed.
 */
export function QuantusExample({ navigation }: { navigation: ExampleNavigationProps }) {
  const [provider, setProvider] = useState<QuantusProvider | null>(
    () => getNoirWallet()?.quantus ?? null
  )
  const [network, setNetwork] = useState<QuantusNetwork | ''>('')
  const [chain, setChain] = useState<QuantusChainInfo | null>(null)
  const [account, setAccount] = useState('')
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [publicKey, setPublicKey] = useState('')
  const [balance, setBalance] = useState<QuantusBalance | null>(null)
  const [extrinsic, setExtrinsic] = useState('')
  const [signedExtrinsic, setSignedExtrinsic] = useState('')
  const [recipient, setRecipient] = useState('')
  const [amountRaw, setAmountRaw] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const symbol = network === 'testnet' ? 'PLK' : 'QTC'

  useEffect(() => {
    if (provider) return
    const controller = new AbortController()
    detectQuantusProvider({ timeoutMs: 3000, signal: controller.signal })
      .then(setProvider)
      .catch(discoveryError => {
        if ((discoveryError as Error).name !== 'AbortError') setError(formatError(discoveryError))
      })
    return () => controller.abort()
  }, [provider])

  const refresh = useCallback(async (current: QuantusProvider) => {
    const [nextNetwork, nextChain, authorized] = await Promise.all([
      current.getNetwork(),
      current.getChain(),
      current.getAccounts()
    ])
    const nextAccount = authorized[0] ?? ''
    setAccounts(authorized)
    setNetwork(nextNetwork)
    setChain(nextChain)
    setAccount(nextAccount)
    if (!nextAccount) {
      setPublicKey('')
      setBalance(null)
      return
    }
    const [nextPublicKey, nextBalance] = await Promise.all([
      current.getPublicKey(),
      current.getBalance()
    ])
    setPublicKey(nextPublicKey)
    setBalance(nextBalance)
  }, [])

  useEffect(() => {
    if (!provider) return
    const onAccountsChanged = () => {
      void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    }
    provider.on('accountsChanged', onAccountsChanged)
    void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    return () => {
      provider.removeListener('accountsChanged', onAccountsChanged)
    }
  }, [provider, refresh])

  const run = async (operation: () => Promise<string | void>) => {
    setBusy(true)
    setError('')
    setResult('')
    try {
      const nextResult = await operation()
      if (nextResult) setResult(nextResult)
      if (provider) await refresh(provider)
    } catch (operationError) {
      setError(formatError(operationError))
    } finally {
      setBusy(false)
    }
  }

  const connect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Quantus provider is unavailable.')
      const connected = await provider.connect()
      setPublicKey(connected.publicKey)
      return `Connected ${connected.address}`
    })

  const disconnect = () =>
    run(async () => {
      if (!provider) throw new Error('Noir Wallet Quantus provider is unavailable.')
      await provider.disconnect()
      return 'Quantus permission revoked.'
    })

  const validateNetwork = () =>
    run(async () => {
      if (!provider || !network) throw new Error('Connect a Quantus account first.')
      await provider.switchNetwork(network)
      return `${network} matches Noir Wallet global mode.`
    })

  const validateChain = () =>
    run(async () => {
      if (!provider || !chain) throw new Error('Connect a Quantus account first.')
      await provider.switchChain({ enum: chain.enum })
      return `${chain.name} matches Noir Wallet global mode.`
    })

  const requireQuantusProvider = () => {
    if (!provider || !account) throw new Error('Connect a Quantus account first.')
    return provider
  }

  const requireQuantusSendIntent = () => {
    if (!recipient.trim()) throw new Error('Enter an SS58-189 Quantus recipient address.')
    if (!/^[1-9][0-9]*$/.test(amountRaw.trim())) {
      throw new Error('Amount must be a positive integer in 12-decimal base units.')
    }
    return { to: recipient.trim(), amount: amountRaw.trim() }
  }

  const sendQuantus = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const intent = requireQuantusSendIntent()
      const extrinsicHash = await requireQuantusProvider().sendQuantus(intent.to, intent.amount)
      return `Extrinsic hash: ${extrinsicHash}`
    })
  }

  const signQuantusTransfer = () =>
    void run(async () => {
      setSignedExtrinsic('')
      const intent = requireQuantusSendIntent()
      const signed = await requireQuantusProvider().signQuantusTransfer(intent.to, intent.amount)
      setSignedExtrinsic(signed)
      return 'Quantus transfer signed successfully. It has not been broadcast.'
    })

  const broadcastExtrinsic = () =>
    run(async () => {
      if (!provider || !account) throw new Error('Connect a Quantus account first.')
      const candidate = extrinsic.trim()
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(candidate)) {
        throw new Error('Enter a signed extrinsic as 0x-prefixed hex bytes.')
      }
      const extrinsicHash = await provider.broadcastExtrinsic(candidate)
      return `Extrinsic hash: ${extrinsicHash}`
    })

  return (
    <ExampleLayout navigation={navigation} available={provider !== null} connected={account !== ''}>
      {!provider && <div className="message warning">Quantus provider is not enabled.</div>}
      <section className="provider-summary card">
        <div className="provider-summary-copy">
          <ExampleChainIcon
            className="provider-hero-icon"
            iconUrl={getExampleChainIconUrl('quantus')}
            label="Quantus"
          />
          <div>
            <p className="section-kicker">Selected provider</p>
            <h2>Quantus provider</h2>
            <p>
              Typed access to accounts, balances, reviewed native sends, and signed extrinsic
              broadcast.
            </p>
          </div>
        </div>
        <div className="provider-actions">
          <button
            className="btn btn-primary"
            onClick={() => void connect()}
            disabled={!provider || busy}
          >
            {account ? 'Reconnect Quantus' : 'Connect Quantus'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void disconnect()}
            disabled={!account || busy}
          >
            Disconnect
          </button>
        </div>
      </section>
      {result && <div className="message success provider-result">{result}</div>}
      {error && <div className="message error provider-result">{error}</div>}
      <div className="tab-panel grid-2">
        <section className="card card-compact">
          <h2>Account &amp; network</h2>
          <Result label="Network" value={network || 'Unavailable'} />
          <Result label="Chain" value={chain?.name ?? 'Unavailable'} />
          <Result label="Address" value={account || 'Not connected'} />
          <Result
            label="Public key"
            value={publicKey ? shortenPublicKey(publicKey) : 'Unavailable'}
          />
          <Result
            label={`Balance (${symbol})`}
            value={balance ? `${formatQuantusUnits(balance.free, 12)} ${symbol}` : 'Unavailable'}
          />
          <Result
            label="Reserved / nonce"
            value={
              balance
                ? `${formatQuantusUnits(balance.reserved, 12)} ${symbol} / ${balance.nonce}`
                : 'Unavailable'
            }
          />
          <div className="button-row compact-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void validateNetwork()}
              disabled={!account || busy}
            >
              Validate network
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void validateChain()}
              disabled={!account || busy}
            >
              Validate chain
            </button>
          </div>
          <p className="field-help">
            These compatibility methods validate the active mode. Change Mainnet/Testnet Mode in
            Noir Wallet settings.
          </p>
        </section>
        <AuthorizedAccountsExample
          accounts={accounts}
          busy={busy}
          onReview={() => void connect()}
        />
        <section className="card card-compact">
          <h2>Send {symbol}</h2>
          <form className="form-stack" onSubmit={sendQuantus}>
            <label className="label" htmlFor="quantus-recipient">
              Recipient
            </label>
            <input
              id="quantus-recipient"
              className="input input-sm"
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="SS58-189 address"
              required
            />
            <label className="label" htmlFor="quantus-amount-raw">
              Amount (base units)
            </label>
            <input
              id="quantus-amount-raw"
              className="input input-sm"
              value={amountRaw}
              onChange={event => setAmountRaw(event.target.value)}
              inputMode="numeric"
              placeholder="1000000000000"
              required
            />
            <p className="field-help">
              Raw u128 base units, {symbol} uses 12 decimals. Keep-alive is fixed and the fee
              ceiling stays with the wallet.
            </p>
            <button className="btn btn-primary btn-full" disabled={!account || busy} type="submit">
              {busy ? 'Sending…' : `Send ${symbol}`}
            </button>
            <button
              className="btn btn-secondary btn-full"
              disabled={!account || busy}
              type="button"
              onClick={() => signQuantusTransfer()}
            >
              Sign only (wallet does not send)
            </button>
            {signedExtrinsic && (
              <div className="message success" role="status">
                <strong>Signature successful — not broadcast.</strong>
                <label className="label" htmlFor="quantus-signed-result">
                  Signed extrinsic (hex)
                </label>
                <textarea
                  id="quantus-signed-result"
                  className="input"
                  value={signedExtrinsic}
                  readOnly
                  rows={3}
                  onFocus={event => event.currentTarget.select()}
                />
              </div>
            )}
            <p className="field-help">
              Sign only returns the signed extrinsic without submitting it. The site owns that
              submission, and the signed transfer can be sent later without another wallet review.
            </p>
          </form>
        </section>
        <section className="card card-compact">
          <h2>Broadcast signed extrinsic</h2>
          <p className="card-hint">
            Submits an extrinsic that was signed elsewhere through{' '}
            <code>author_submitExtrinsic</code>. Message and generic-call signing are not exposed by
            the provider.
          </p>
          <textarea
            className="input textarea"
            value={extrinsic}
            onChange={event => setExtrinsic(event.target.value)}
            rows={4}
            placeholder="0x… signed SCALE extrinsic"
            aria-label="Signed extrinsic hex"
          />
          <button
            className="btn btn-primary btn-full"
            onClick={() => void broadcastExtrinsic()}
            disabled={!account || !extrinsic.trim() || busy}
          >
            Broadcast extrinsic
          </button>
        </section>
      </div>
    </ExampleLayout>
  )
}

type NativeExampleProvider = SolanaProvider | NearProvider

export function NativeTransferExample({
  navigation,
  chain
}: {
  navigation: ExampleNavigationProps
  chain: 'solana' | 'near'
}) {
  const walletProvider = getNoirWallet()?.[chain] ?? null
  const [provider, setProvider] = useState<NativeExampleProvider | null>(walletProvider)
  const [account, setAccount] = useState('')
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [serializedTransaction, setSerializedTransaction] = useState('')
  const [message, setMessage] = useState('Hello Noir Wallet')
  const [nearReceiver, setNearReceiver] = useState('')
  const [nearMethod, setNearMethod] = useState('get_status')
  const [nearArgs, setNearArgs] = useState('{}')
  const [nearGas, setNearGas] = useState('30000000000000')
  const [nearDeposit, setNearDeposit] = useState('0')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const displayName = chain === 'solana' ? 'Solana' : 'NEAR'

  useEffect(() => {
    if (provider) return
    const controller = new AbortController()
    const detection =
      chain === 'solana'
        ? detectSolanaProvider({ timeoutMs: 3000, signal: controller.signal })
        : detectNearProvider({ timeoutMs: 3000, signal: controller.signal })
    detection.then(setProvider).catch(discoveryError => {
      if ((discoveryError as Error).name !== 'AbortError') setError(formatError(discoveryError))
    })
    return () => controller.abort()
  }, [chain, provider])

  const refresh = useCallback(
    async (current: NativeExampleProvider) => {
      const authorized = await current.getAccounts()
      setAccounts(authorized)
      setAccount(authorized[0] ?? '')
    },
    [chain]
  )

  useEffect(() => {
    if (!provider) return
    const onAccountsChanged = () => {
      void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    }
    if (chain === 'solana') {
      ;(provider as SolanaProvider).on('accountsChanged', onAccountsChanged)
    } else {
      ;(provider as NearProvider).on('accountChanged', onAccountsChanged)
    }
    void refresh(provider).catch(refreshError => setError(formatError(refreshError)))
    return () => {
      if (chain === 'solana') {
        ;(provider as SolanaProvider).removeListener('accountsChanged', onAccountsChanged)
      } else {
        ;(provider as NearProvider).removeListener('accountChanged', onAccountsChanged)
      }
    }
  }, [chain, provider, refresh])

  const run = async (operation: () => Promise<string>) => {
    setBusy(true)
    setError('')
    setResult('')
    try {
      setResult(await operation())
      if (provider) await refresh(provider)
    } catch (operationError) {
      setError(formatError(operationError))
    } finally {
      setBusy(false)
    }
  }

  const signNearTransaction = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!provider || chain !== 'near' || !account)
        throw new Error('Connect a NEAR account first.')
      const signed = await (provider as NearProvider).signTransaction({
        receiverId: nearReceiver.trim(),
        actions: [
          {
            methodName: nearMethod.trim(),
            args: JSON.parse(nearArgs) as Readonly<Record<string, unknown>>,
            gas: nearGas,
            deposit: nearDeposit
          }
        ]
      })
      return `Signed transaction: ${signed}`
    })
  }

  return (
    <ExampleLayout navigation={navigation} available={provider !== null} connected={account !== ''}>
      {!provider && <div className="message warning">{displayName} provider is not enabled.</div>}
      <section className="provider-summary card">
        <div className="provider-summary-copy">
          <ExampleChainIcon
            className="provider-hero-icon"
            iconUrl={getExampleChainIconUrl(chain)}
            label={displayName}
          />
          <div>
            <p className="section-kicker">Mainnet &amp; Testnet provider</p>
            <h2>{displayName} dApp provider</h2>
            <p>Connect and request standard transaction or message signatures.</p>
          </div>
        </div>
        <div className="provider-actions">
          <button
            className="btn btn-primary"
            disabled={!provider || busy}
            onClick={() =>
              void run(async () => {
                if (!provider) throw new Error(`${displayName} provider is unavailable.`)
                if (chain === 'solana') {
                  return `Connected ${(await (provider as SolanaProvider).connect()).publicKey.toString()}`
                }
                return `Connected ${(await (provider as NearProvider).requestSignIn()).accountId}`
              })
            }
          >
            Connect {displayName}
          </button>
          <button
            className="btn btn-secondary"
            disabled={!account || busy}
            onClick={() =>
              void run(async () => {
                if (!provider) throw new Error(`${displayName} provider is unavailable.`)
                if (chain === 'solana') await (provider as SolanaProvider).disconnect()
                else await (provider as NearProvider).signOut()
                return `${displayName} disconnected.`
              })
            }
          >
            Disconnect
          </button>
        </div>
      </section>
      <div className="tab-panel grid-2">
        <section className="card card-compact">
          <h2>Authorized account</h2>
          <Result label="Address" value={account || 'Not connected'} />
          <p className="provider-hint">
            Balance and token reads use the dApp&apos;s own {displayName} RPC client.
          </p>
        </section>
        <AuthorizedAccountsExample
          accounts={accounts}
          busy={busy}
          onReview={() =>
            void run(async () => {
              if (!provider) throw new Error(`${displayName} provider is unavailable.`)
              if (chain === 'solana') {
                await (provider as SolanaProvider).connect()
              } else {
                await (provider as NearProvider).requestSignIn()
              }
              return `${displayName} account authorization updated.`
            })
          }
        />
        {chain === 'near' && (
          <section className="card card-compact">
            <h2>Sign NEAR function call</h2>
            <form className="form-stack" onSubmit={signNearTransaction}>
              <input
                className="input input-sm"
                value={nearReceiver}
                onChange={event => setNearReceiver(event.target.value)}
                placeholder="receiver.near"
                required
              />
              <input
                className="input input-sm"
                value={nearMethod}
                onChange={event => setNearMethod(event.target.value)}
                placeholder="Method name"
                required
              />
              <textarea
                className="input"
                value={nearArgs}
                onChange={event => setNearArgs(event.target.value)}
                rows={3}
                aria-label="JSON arguments"
              />
              <input
                className="input input-sm"
                value={nearGas}
                onChange={event => setNearGas(event.target.value)}
                aria-label="Gas"
                required
              />
              <input
                className="input input-sm"
                value={nearDeposit}
                onChange={event => setNearDeposit(event.target.value)}
                aria-label="Deposit in yoctoNEAR"
                required
              />
              <button className="btn btn-primary btn-full" disabled={!account || busy}>
                Sign transaction
              </button>
            </form>
          </section>
        )}
        {chain === 'solana' && (
          <section className="card card-compact">
            <h2>Sign serialized transaction</h2>
            <label className="label" htmlFor="solana-serialized-transaction">
              Canonical base64 transaction
            </label>
            <textarea
              id="solana-serialized-transaction"
              className="input"
              value={serializedTransaction}
              onChange={event => setSerializedTransaction(event.target.value)}
              rows={5}
            />
            <div className="provider-actions">
              <button
                className="btn btn-secondary"
                disabled={!account || !serializedTransaction || busy}
                onClick={() =>
                  void run(async () => {
                    if (!provider) throw new Error('Solana provider is unavailable.')
                    const signed = await (provider as SolanaProvider).signTransaction(
                      base64ToBytes(serializedTransaction.trim())
                    )
                    return `Signed transaction: ${bytesToBase64(signed)}`
                  })
                }
              >
                Sign only
              </button>
              <button
                className="btn btn-primary"
                disabled={!account || !serializedTransaction || busy}
                onClick={() =>
                  void run(async () => {
                    if (!provider) throw new Error('Solana provider is unavailable.')
                    const { signature } = await (provider as SolanaProvider).signAndSendTransaction(
                      base64ToBytes(serializedTransaction.trim())
                    )
                    return `Transaction: ${signature}`
                  })
                }
              >
                Sign &amp; broadcast
              </button>
            </div>
          </section>
        )}
        <section className="card card-compact">
          <h2>Sign message</h2>
          <textarea
            className="input"
            value={message}
            onChange={event => setMessage(event.target.value)}
            rows={4}
          />
          <button
            className="btn btn-primary btn-full"
            disabled={!account || !message || busy || (chain === 'near' && !nearReceiver)}
            onClick={() =>
              void run(async () => {
                if (!provider) throw new Error(`${displayName} provider is unavailable.`)
                if (chain === 'solana') {
                  const signed = await (provider as SolanaProvider).signMessage(
                    new TextEncoder().encode(message)
                  )
                  return `Signature: ${bytesToBase64(signed.signature)}`
                }
                const signed = await (provider as NearProvider).signMessage({
                  message,
                  recipient: nearReceiver.trim(),
                  nonce: crypto.getRandomValues(new Uint8Array(32))
                })
                return `Signature: ${signed.signature}`
              })
            }
          >
            Sign message
          </button>
        </section>
      </div>
      {result && <div className="message success provider-result">{result}</div>}
      {error && <div className="message error provider-result">{error}</div>}
    </ExampleLayout>
  )
}
