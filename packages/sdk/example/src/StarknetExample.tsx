import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getNoirWallet } from '@noir-wallet/sdk'
import { getExampleChainIconUrl } from './evm-network-catalog'
import {
  AuthorizedAccountsExample,
  ExampleChainIcon,
  ExampleLayout,
  type ExampleNavigationProps
} from './ProviderExamples'

const STARKNET_STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
const STARKNET_BALANCE_SELECTORS = [
  '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e',
  '0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33'
] as const
const STRK_DECIMALS = 18
const FELT_PRIME = 0x800000000000011000000000000000000000000000000000000000000000001n
const FELT_CHAIN_IDS = {
  mainnet: '0x534e5f4d41494e',
  testnet: '0x534e5f5345504f4c4941'
} as const
const DOMAIN_CHAIN_IDS = {
  mainnet: 'SN_MAIN',
  testnet: 'SN_SEPOLIA'
} as const

export function starknetExampleNetworkMode(
  chainId: string
): ExampleNavigationProps['networkMode'] | null {
  const trimmed = chainId.trim()
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) return null
  const value = BigInt(trimmed)
  if (value >= FELT_PRIME) return null
  if (value === BigInt(FELT_CHAIN_IDS.mainnet)) return 'mainnet'
  if (value === BigInt(FELT_CHAIN_IDS.testnet)) return 'testnet'
  return null
}

function describeStarknetNetwork(chainId: string) {
  const mode = starknetExampleNetworkMode(chainId)
  if (!mode) return null
  return {
    mode,
    felt: FELT_CHAIN_IDS[mode],
    domain: DOMAIN_CHAIN_IDS[mode],
    label: mode === 'mainnet' ? 'Starknet' : 'Starknet Sepolia'
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = Reflect.get(error, 'message')
    if (typeof message === 'string') return message
  }
  return 'The Starknet request failed.'
}

function starknetRpcUrl(networkMode: ExampleNavigationProps['networkMode']): string {
  return networkMode === 'mainnet'
    ? 'https://starknet-rpc.publicnode.com'
    : 'https://starknet-sepolia-rpc.publicnode.com'
}

function parseFelt(value: string, label: string): string {
  const trimmed = value.trim()
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(trimmed) || BigInt(trimmed) >= FELT_PRIME) {
    throw new Error(`${label} must be a Starknet felt.`)
  }
  return trimmed
}

function normalizeFelt(value: string, label: string): string {
  const hex = parseFelt(value, label).slice(2).replace(/^0+/, '').toLowerCase()
  if (!hex) throw new Error(`${label} must be a Starknet felt.`)
  return `0x${hex}`
}

function parseContractAddress(value: string): string {
  try {
    return parseFelt(value, 'Contract')
  } catch {
    throw new Error('Enter a valid NoirTestBench contract address.')
  }
}

function parseStrk(value: string): readonly [string, string] {
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) {
    throw new Error('STRK amount must be a non-negative decimal with at most 18 decimal places.')
  }
  const [whole, fraction = ''] = normalized.split('.')
  const raw =
    BigInt(whole) * 10n ** BigInt(STRK_DECIMALS) + BigInt(fraction.padEnd(STRK_DECIMALS, '0'))
  if (raw <= 0n) throw new Error('STRK amount must be greater than zero.')
  const low = raw & ((1n << 128n) - 1n)
  const high = raw >> 128n
  return [`0x${low.toString(16)}`, `0x${high.toString(16)}`]
}

function formatStrk(raw: bigint): string {
  const whole = raw / 10n ** BigInt(STRK_DECIMALS)
  const fraction = (raw % 10n ** BigInt(STRK_DECIMALS))
    .toString()
    .padStart(STRK_DECIMALS, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString()
}

function encodeU256(value: bigint): readonly [string, string] {
  const low = value & ((1n << 128n) - 1n)
  const high = value >> 128n
  return [`0x${low.toString(16)}`, `0x${high.toString(16)}`]
}

function assertShortstring(value: string): string {
  if (value.length < 1 || value.length > 31 || !/^[\x20-\x7E]+$/.test(value)) {
    throw new Error('The message must be 1–31 printable ASCII characters.')
  }
  return value
}

function formatSignature(signature: readonly string[]): string {
  const [r, s] = signature
  if (typeof r !== 'string' || typeof s !== 'string' || signature.length !== 2) {
    throw new Error('Starknet typed data did not return [r, s].')
  }
  const word = (value: string) => parseFelt(value, 'Signature').slice(2).padStart(64, '0')
  return `0x${word(r)}${word(s)}`
}

class StarknetCallError extends Error {
  readonly code: number | null

  constructor(message: string, code: number | null) {
    super(message)
    this.name = 'StarknetCallError'
    this.code = code
  }
}

function isMissingEntrypoint(error: unknown): boolean {
  return (
    error instanceof StarknetCallError &&
    (error.code === 40 ||
      error.code === 21 ||
      /ENTRYPOINT_NOT_FOUND|Entry point not found|does not exist/i.test(error.message))
  )
}

async function callStrkBalance(
  networkMode: ExampleNavigationProps['networkMode'],
  account: string,
  selector: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(starknetRpcUrl(networkMode), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'starknet_call',
      params: {
        request: {
          contract_address: normalizeFelt(STARKNET_STRK, 'Contract'),
          entry_point_selector: normalizeFelt(selector, 'Selector'),
          calldata: [normalizeFelt(account, 'Account')]
        },
        block_id: 'pre_confirmed'
      }
    }),
    cache: 'no-store',
    signal
  })
  if (!response.ok) throw new StarknetCallError('Starknet balance request failed.', null)
  const body = (await response.json()) as {
    result?: unknown
    error?: { code?: unknown; message?: unknown }
  }
  if (body.error) {
    const code = typeof body.error.code === 'number' ? body.error.code : null
    const message =
      typeof body.error.message === 'string' && body.error.message
        ? body.error.message
        : 'Starknet balance request failed.'
    throw new StarknetCallError(message, code)
  }
  if (!Array.isArray(body.result) || typeof body.result[0] !== 'string') {
    throw new StarknetCallError('Starknet balance response was empty.', null)
  }
  const low = BigInt(parseFelt(body.result[0], 'Balance'))
  const high =
    typeof body.result[1] === 'string' ? BigInt(parseFelt(body.result[1], 'Balance')) : 0n
  return formatStrk(low + (high << 128n))
}

async function readStrkBalance(
  networkMode: ExampleNavigationProps['networkMode'],
  account: string,
  signal?: AbortSignal
): Promise<string> {
  const amounts: string[] = []
  for (const selector of STARKNET_BALANCE_SELECTORS) {
    try {
      amounts.push(await callStrkBalance(networkMode, account, selector, signal))
    } catch (error) {
      if (signal?.aborted || !isMissingEntrypoint(error)) throw error
    }
  }
  if (amounts.length === 0) throw new StarknetCallError('Starknet balance call failed.', null)
  if (amounts.length === 2 && amounts[0] !== amounts[1]) {
    throw new StarknetCallError('Starknet balance selectors disagree.', null)
  }
  return amounts[0]
}

function Result({ label, value }: { label: string; value: string }) {
  return (
    <div className="result-item">
      <span className="label">{label}</span>
      <code className="result-code">{value}</code>
    </div>
  )
}

export function StarknetExample({ navigation }: { navigation: ExampleNavigationProps }) {
  const [account, setAccount] = useState('')
  const [accounts, setAccounts] = useState<readonly string[]>([])
  const [chainId, setChainId] = useState('')
  const [balance, setBalance] = useState('')
  const [balanceError, setBalanceError] = useState<string | null>(null)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('Hello Noir Wallet')
  const [contractAddress, setContractAddress] = useState('')
  const [contractValue, setContractValue] = useState('42')
  const [contractDeposit, setContractDeposit] = useState('0.0001')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const provider = getNoirWallet()?.starknet
  const chainLabel = navigation.networkMode === 'mainnet' ? 'Starknet' : 'Starknet Sepolia'
  const networkMode = navigation.networkMode
  const onNetworkModeChange = navigation.onNetworkModeChange
  const balanceGeneration = useRef(0)
  const networkModeRef = useRef(networkMode)
  networkModeRef.current = networkMode
  const onNetworkModeChangeRef = useRef(onNetworkModeChange)
  onNetworkModeChangeRef.current = onNetworkModeChange

  useEffect(() => {
    if (!provider) return
    let cancelled = false
    void (async () => {
      try {
        const nextChainId = await provider.request<string>({ type: 'wallet_requestChainId' })
        if (cancelled) return
        const network = describeStarknetNetwork(nextChainId)
        if (network) {
          setChainId(nextChainId)
          onNetworkModeChange(network.mode)
        }
        const nextAccounts = await provider.request<readonly string[]>({
          type: 'wallet_requestAccounts',
          params: { silent_mode: true }
        })
        if (cancelled || !Array.isArray(nextAccounts)) return
        setAccounts(nextAccounts)
        setAccount(nextAccounts[0] ?? '')
      } catch {
        // Leave the card disconnected when the wallet has not authorized this origin.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider, onNetworkModeChange])

  const loadNativeBalance = async (address: string, signal?: AbortSignal) => {
    const generation = ++balanceGeneration.current
    try {
      if (!provider) throw new Error('Starknet is not enabled in this wallet build.')
      const nextChainId = await provider.request<string>({ type: 'wallet_requestChainId' })
      if (signal?.aborted || balanceGeneration.current !== generation) return
      const network = describeStarknetNetwork(nextChainId)
      if (!network) throw new Error('Noir Wallet returned an unsupported Starknet chain.')
      setChainId(nextChainId)
      if (network.mode !== networkModeRef.current) onNetworkModeChangeRef.current(network.mode)
      const nextBalance = await readStrkBalance(network.mode, address, signal)
      if (signal?.aborted || balanceGeneration.current !== generation) return
      setBalance(nextBalance)
      setBalanceError(null)
    } catch (error) {
      if (!signal?.aborted && balanceGeneration.current === generation) {
        setBalance('')
        setBalanceError(formatError(error))
      }
    }
  }

  useEffect(() => {
    if (!provider || !account) {
      balanceGeneration.current += 1
      setBalance('')
      setBalanceError(null)
      return
    }
    const controller = new AbortController()
    void loadNativeBalance(account, controller.signal)
    return () => {
      balanceGeneration.current += 1
      controller.abort()
    }
  }, [account, provider])

  const run = async (action: () => Promise<string>) => {
    setError(null)
    setResult(null)
    setBusy(true)
    try {
      setResult(await action())
    } catch (caught) {
      setError(formatError(caught))
    } finally {
      setBusy(false)
    }
  }

  const request = <T,>(type: string, params?: Readonly<Record<string, unknown>>) => {
    if (!provider) throw new Error('Starknet is not enabled in this wallet build.')
    return provider.request<T>({ type, ...(params ? { params } : {}) })
  }

  const syncWalletNetwork = async () => {
    const nextChainId = await request<string>('wallet_requestChainId')
    const network = describeStarknetNetwork(nextChainId)
    if (!network) throw new Error('Noir Wallet returned an unsupported Starknet chain.')
    setChainId(nextChainId)
    if (network.mode !== networkMode) onNetworkModeChange(network.mode)
    return network
  }

  const rememberAccounts = (nextAccounts: readonly string[]) => {
    setAccounts(nextAccounts)
    setAccount(nextAccounts[0] ?? '')
  }

  const refreshBalance = (address: string) => loadNativeBalance(address)

  const typedData = (contents: string, domainName: string, domainChainId: string) => ({
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' }
      ],
      Message: [{ name: 'contents', type: 'shortstring' }]
    },
    primaryType: 'Message',
    domain: { name: domainName, version: '1', chainId: domainChainId, revision: '1' },
    message: { contents }
  })

  const signContents = async (domainName: string) => {
    if (!account) throw new Error('Connect a Starknet account first.')
    const network = await syncWalletNetwork()
    const contents = assertShortstring(message)
    const signature = await request<readonly string[]>('wallet_signTypedData', {
      typed_data: typedData(contents, domainName, network.domain)
    })
    return formatSignature(signature)
  }

  const submitTransfer = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      if (!account) throw new Error('Connect a Starknet account first.')
      const [low, high] = parseStrk(amount)
      const sent = await request<{ transaction_hash: string }>('wallet_addInvokeTransaction', {
        invoke_transaction: [
          {
            contract_address: STARKNET_STRK,
            entry_point: 'transfer',
            calldata: [parseFelt(recipient, 'Recipient'), low, high]
          }
        ]
      })
      await refreshBalance(account)
      return `Transaction: ${sent.transaction_hash}`
    })
  }

  const signMessage = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => `Personal signature: ${await signContents('Noir')}`)
  }

  const signTypedData = () =>
    run(async () => `Typed-data signature: ${await signContents('Noir Wallet SDK Example')}`)

  const addNetwork = () =>
    void run(async () => {
      if (!account) throw new Error('Connect a Starknet account first.')
      const network = await syncWalletNetwork()
      await request('wallet_switchStarknetChain', { chainId: network.felt })
      return `${network.label} is already available in Noir Wallet.`
    })

  const callTestBench = (functionName: 'increment' | 'setValue' | 'deposit' | 'alwaysRevert') =>
    void run(async () => {
      if (!account) throw new Error('Connect a Starknet account first.')
      const target = parseContractAddress(contractAddress)
      if (!/^\d+$/.test(contractValue)) throw new Error('Test value must be an unsigned integer.')
      const calls =
        functionName === 'deposit'
          ? [
              {
                contract_address: STARKNET_STRK,
                entry_point: 'transfer',
                calldata: [target, ...parseStrk(contractDeposit)]
              },
              { contract_address: target, entry_point: 'deposit', calldata: [] }
            ]
          : [
              {
                contract_address: target,
                entry_point: functionName,
                calldata: functionName === 'setValue' ? [...encodeU256(BigInt(contractValue))] : []
              }
            ]
      const sent = await request<{ transaction_hash: string }>('wallet_addInvokeTransaction', {
        invoke_transaction: calls
      })
      await refreshBalance(account)
      return `${functionName} transaction: ${sent.transaction_hash}`
    })

  return (
    <ExampleLayout navigation={navigation} available={provider != null} connected={account !== ''}>
      {!provider && <div className="message warning">Starknet provider is not enabled.</div>}
      <section className="provider-summary card">
        <div className="provider-summary-copy">
          <ExampleChainIcon
            className="provider-hero-icon"
            iconUrl={getExampleChainIconUrl('starknet')}
            label={chainLabel}
          />
          <div>
            <p className="section-kicker">Selected provider</p>
            <h2>Starknet provider</h2>
            <p>Wallet API 0.10.4. STRK20 methods are unsupported.</p>
          </div>
        </div>
        <div className="provider-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!provider || busy}
            onClick={() =>
              void run(async () => {
                const nextAccounts = await request<readonly string[]>('wallet_requestAccounts')
                rememberAccounts(nextAccounts)
                await syncWalletNetwork()
                return nextAccounts[0] ? `Connected ${nextAccounts[0]}` : 'No account returned'
              })
            }
          >
            {account ? 'Reconnect Starknet' : 'Connect Starknet'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!account || busy}
            onClick={() =>
              void run(async () => {
                await request('wallet_disconnect')
                rememberAccounts([])
                setChainId('')
                return 'Starknet permission revoked.'
              })
            }
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
            value={balance ? `${balance} native units` : (balanceError ?? 'Unavailable')}
          />
          <details className="network-method-example">
            <summary>Starknet chain example</summary>
            <p>
              Noir Wallet follows the selected network mode. This requests that chain and succeeds
              when it already matches.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-full"
              onClick={addNetwork}
              disabled={!account || busy}
            >
              Add {chainLabel}
            </button>
          </details>
        </section>
        <AuthorizedAccountsExample
          accounts={accounts}
          busy={busy}
          onReview={() =>
            void run(async () => {
              if (!provider) throw new Error('Starknet is not enabled in this wallet build.')
              const nextAccounts = await request<readonly string[]>('wallet_requestAccounts', {
                force_review: true
              })
              rememberAccounts(nextAccounts)
              return 'Starknet account authorization updated.'
            })
          }
        />
        <section className="card card-compact">
          <h2>Send native asset</h2>
          <form className="form-stack" onSubmit={submitTransfer}>
            <label className="label" htmlFor="starknet-recipient">
              Recipient
            </label>
            <input
              id="starknet-recipient"
              className="input input-sm"
              value={recipient}
              onChange={event => setRecipient(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
              required
            />
            <label className="label" htmlFor="starknet-amount">
              Amount (native token)
            </label>
            <input
              id="starknet-amount"
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
            There is no preset Starknet contract. The address must expose increment, setValue,
            deposit, and alwaysRevert. setValue takes a u256. Payable deposit transfers STRK, then
            calls deposit with no arguments. A contract without those entry points fails during
            estimation, before approval.
          </p>
          <div className="form-stack">
            <label className="label" htmlFor="starknet-contract-address">
              NoirTestBench address
            </label>
            <input
              id="starknet-contract-address"
              className="input input-sm"
              value={contractAddress}
              onChange={event => setContractAddress(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
            />
            <div className="contract-fields">
              <div className="form-group">
                <label className="label" htmlFor="starknet-contract-value">
                  setValue argument
                </label>
                <input
                  id="starknet-contract-value"
                  className="input input-sm"
                  value={contractValue}
                  onChange={event => setContractValue(event.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div className="form-group">
                <label className="label" htmlFor="starknet-contract-deposit">
                  Deposit amount
                </label>
                <input
                  id="starknet-contract-deposit"
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
                onClick={() => callTestBench('increment')}
                disabled={!account || busy}
              >
                Increment
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => callTestBench('setValue')}
                disabled={!account || busy}
              >
                Set value
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => callTestBench('deposit')}
                disabled={!account || busy}
              >
                Payable deposit
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => callTestBench('alwaysRevert')}
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
            <label className="label" htmlFor="starknet-message">
              Message
            </label>
            <textarea
              id="starknet-message"
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
