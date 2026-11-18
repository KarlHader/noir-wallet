import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  PublicAccount,
  PublicAssets,
  PublicTransaction,
  SendPublicTransactionParams,
  NoirWalletProvider
} from '@noir-wallet/sdk'
import { NoirPublicClient, switchEvmChain, verifyMessageSignature } from '@noir-wallet/sdk'
import { verifyMessage } from 'viem'
import {
  buildTransferRequest,
  displayAssetSymbol,
  formatAssetBalance,
  initialRequests,
  parseRequests,
  supportedTransferAssets
} from './requests'
import {
  errorCode,
  errorMessage,
  exportTrace,
  publicConnectErrorMessage,
  type TraceEntry,
  type TraceMethod
} from './trace'
import {
  assertPublicMainnet,
  buildPublicSessionRequest,
  autoPublicScopes,
  evmPublicScope,
  publicSessionConnections,
  readPublicConnection,
  zcashPublicScope,
  type PublicChain,
  type PublicConnection
} from './connection'

type ComposeMode = 'transfer' | 'function'
type Intent = Readonly<SendPublicTransactionParams>

export function PublicDemo({ wallet }: { wallet: NoirWalletProvider }) {
  const [selectedChain, setSelectedChain] = useState<PublicChain>('auto')
  const [connection, setConnection] = useState<PublicConnection | null>(null)
  const [account, setAccount] = useState<PublicAccount | null>(null)
  const [signingMessage, setSigningMessage] = useState('')
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [signingResult, setSigningResult] = useState<{
    signature: string
    verified: boolean
    error?: string
  } | null>(null)
  const [assets, setAssets] = useState<PublicAssets | null>(null)
  const [transaction, setTransaction] = useState<PublicTransaction | null>(null)
  const [operationId, setOperationId] = useState('')
  const [lookupAttempted, setLookupAttempted] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [assetsBusy, setAssetsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<ComposeMode>('transfer')
  const [tokenId, setTokenId] = useState('zec.omft.near')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [requests, setRequests] = useState(initialRequests)
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID())
  const [intent, setIntent] = useState<Intent | null>(null)
  const [trace, setTrace] = useState<TraceEntry[]>([])

  const accountRef = useRef<PublicAccount | null>(null)
  const intentRef = useRef<Intent | null>(null)
  const epoch = useRef(0)
  const lookupRevision = useRef(0)
  const busyRef = useRef(false)
  const assetsBusyEpoch = useRef<number | null>(null)
  const assetsRefreshQueued = useRef(false)
  const lookupBusyRevision = useRef<number | null>(null)
  const sequence = useRef(0)
  const callSequence = useRef(0)
  const connectionRevision = useRef(0)
  const selectedChainRef = useRef(selectedChain)
  const connectionRef = useRef(connection)
  const selectedScopeRef = useRef<string | null>(null)
  const expectedSwitchScopeRef = useRef<string | null>(null)
  const client = useMemo(
    () =>
      connection && wallet.multichain
        ? new NoirPublicClient(wallet.multichain, connection.scope)
        : null,
    [connection?.scope, wallet.multichain]
  )
  const walletVersion = wallet.version
  const build = typeof __PUBLIC_DEMO_BUILD__ === 'undefined' ? null : __PUBLIC_DEMO_BUILD__

  const appendTrace = useCallback((entry: Omit<TraceEntry, 'sequence' | 'at'>) => {
    const next = {
      ...entry,
      sequence: ++sequence.current,
      at: new Date().toISOString()
    }
    setTrace(current => [...current, next].slice(-100))
  }, [])

  const traced = useCallback(
    async <T,>(
      method: TraceMethod,
      task: () => Promise<T>,
      status?: (value: T) => string | undefined
    ): Promise<T> => {
      const start = performance.now()
      const callId = ++callSequence.current
      appendTrace({ callId, method, outcome: 'started' })
      try {
        const result = await task()
        appendTrace({
          callId,
          method,
          outcome: 'success',
          elapsedMs: Math.round(performance.now() - start),
          status: status?.(result)
        })
        return result
      } catch (cause) {
        appendTrace({
          callId,
          method,
          outcome: 'error',
          elapsedMs: Math.round(performance.now() - start),
          code: errorCode(cause)
        })
        throw cause
      }
    },
    [appendTrace]
  )

  const clearAccount = useCallback(() => {
    epoch.current += 1
    lookupRevision.current += 1
    assetsRefreshQueued.current = false
    accountRef.current = null
    intentRef.current = null
    setAccount(null)
    setSigningResult(null)
    setPublicKey(null)
    setAssets(null)
    setAssetsBusy(false)
    setTransaction(null)
    setOperationId('')
    setLookupAttempted(false)
    setIntent(null)
    setRequestId(crypto.randomUUID())
  }, [])

  const adoptAccount = useCallback((next: PublicAccount) => {
    const previous = accountRef.current
    if (
      !previous ||
      previous.address !== next.address ||
      previous.network !== next.network ||
      previous.parentContractId !== next.parentContractId
    ) {
      epoch.current += 1
      lookupRevision.current += 1
      assetsRefreshQueued.current = false
      intentRef.current = null
      setIntent(null)
      setRequestId(crypto.randomUUID())
      setAssets(null)
      setTransaction(null)
      setOperationId('')
      setLookupAttempted(false)
      setSigningResult(null)
      setPublicKey(null)
    }
    accountRef.current = next
    setAccount(next)
  }, [])

  const refreshAssets = useCallback(
    async (force = false): Promise<void> => {
      if (!client) return
      const currentEpoch = epoch.current
      if (assetsBusyEpoch.current === currentEpoch) {
        if (force) assetsRefreshQueued.current = true
        return
      }
      assetsBusyEpoch.current = currentEpoch
      setAssetsBusy(true)
      try {
        const result = await traced('getPublicAssets', () => client.getPublicAssets())
        if (currentEpoch === epoch.current) {
          adoptAccount(result.account)
          setAssets(result)
        }
      } catch (cause) {
        if (currentEpoch === epoch.current) setError(errorMessage(cause))
      } finally {
        if (assetsBusyEpoch.current === currentEpoch) {
          assetsBusyEpoch.current = null
          setAssetsBusy(false)
          if (assetsRefreshQueued.current) {
            assetsRefreshQueued.current = false
            void refreshAssets()
          }
        }
      }
    },
    [client, traced, adoptAccount]
  )

  const adoptConnection = useCallback(
    (next: PublicConnection | null) => {
      const previous = connectionRef.current
      if (
        previous?.scope !== next?.scope ||
        previous?.accounts.join('\0') !== next?.accounts.join('\0')
      ) {
        clearAccount()
      }
      connectionRef.current = next
      setConnection(next)
    },
    [clearAccount]
  )

  const restoreSession = useCallback(
    async (allowSwitch = true) => {
      const revision = ++connectionRevision.current
      setRestoring(true)
      const multichain = wallet.multichain
      if (!multichain) {
        adoptConnection(null)
        setRestoring(false)
        return
      }
      try {
        const session = await traced('getSession', () => multichain.getSession())
        if (revision !== connectionRevision.current) return
        let currentEvmScope: string | null = null
        if (wallet.ethereum) {
          let currentEvmChainId: string | null = null
          try {
            currentEvmChainId = await wallet.ethereum.request<string>({ method: 'eth_chainId' })
          } catch (cause) {
            if (publicSessionConnections(session).some(candidate => candidate.chain === 'evm')) {
              throw cause
            }
          }
          assertPublicMainnet(currentEvmChainId)
          if (currentEvmChainId) currentEvmScope = evmPublicScope(currentEvmChainId)
        }
        if (revision !== connectionRevision.current) return
        const chain = selectedChainRef.current
        if (chain !== 'auto') {
          const scope = chain === 'evm' ? currentEvmScope : zcashPublicScope('mainnet')
          const next = scope ? readPublicConnection(session, scope) : null
          selectedScopeRef.current = next?.scope ?? null
          adoptConnection(next)
          setError(null)
          return
        }
        const connections = publicSessionConnections(session)
        const cached = connections.find(
          candidate =>
            candidate.scope === selectedScopeRef.current &&
            (candidate.chain === 'zcash' || candidate.scope === currentEvmScope)
        )
        if (cached) {
          adoptConnection(cached)
          setError(null)
          return
        }
        const seed =
          connections.find(candidate => candidate.scope === currentEvmScope) ??
          connections.find(candidate => candidate.chain === 'zcash') ??
          connections[0]
        if (!seed) {
          selectedScopeRef.current = null
          adoptConnection(null)
          setError(null)
          return
        }
        const selection = await traced('selectPublicAccount', () =>
          new NoirPublicClient(multichain, seed.scope).selectPublicAccount()
        )
        if (revision !== connectionRevision.current) return
        const chosen = connections.find(candidate => candidate.scope === selection.scope)
        if (!chosen || selection.account.chain !== (chosen.chain === 'evm' ? 'evm' : 'zcash-l2')) {
          throw new Error('Wallet selected an unauthorized Public account.')
        }
        if (chosen.chain === 'evm' && chosen.scope !== currentEvmScope) {
          if (!wallet.ethereum || !allowSwitch) {
            adoptConnection(null)
            return
          }
          selectedScopeRef.current = chosen.scope
          expectedSwitchScopeRef.current = chosen.scope
          try {
            await traced('switchEvmChain', () =>
              switchEvmChain(wallet.ethereum!, `0x${BigInt(chosen.scope.slice(7)).toString(16)}`)
            )
          } catch (cause) {
            expectedSwitchScopeRef.current = null
            throw cause
          }
          if (expectedSwitchScopeRef.current === chosen.scope) {
            expectedSwitchScopeRef.current = null
          }
          if (revision !== connectionRevision.current) return
          const switched = evmPublicScope(
            await wallet.ethereum.request<string>({ method: 'eth_chainId' })
          )
          if (revision !== connectionRevision.current) return
          if (switched !== chosen.scope) throw new Error('The selected EVM network is not active.')
        }
        selectedScopeRef.current = chosen.scope
        adoptConnection(chosen)
        adoptAccount(selection.account)
        setError(null)
      } catch (cause) {
        if (revision === connectionRevision.current) {
          adoptConnection(null)
          setError(errorMessage(cause))
        }
      } finally {
        if (revision === connectionRevision.current) setRestoring(false)
      }
    },
    [wallet.multichain, wallet.ethereum, traced, adoptConnection, adoptAccount]
  )

  useEffect(() => {
    const onSessionChanged = () => {
      appendTrace({ method: 'wallet_sessionChanged', outcome: 'event' })
      adoptConnection(null)
      void restoreSession()
    }
    const onAccountsChanged = () => {
      appendTrace({ method: 'accountsChanged', outcome: 'event' })
      selectedScopeRef.current = null
      adoptConnection(null)
      void restoreSession()
    }
    const onChainChanged = (chainId: unknown) => {
      appendTrace({ method: 'chainChanged', outcome: 'event' })
      const expected = expectedSwitchScopeRef.current
      expectedSwitchScopeRef.current = null
      let changedScope: string | null = null
      try {
        changedScope = evmPublicScope(chainId)
      } catch {
        // The next session read will validate the active chain.
      }
      selectedScopeRef.current = changedScope === expected ? expected : null
      adoptConnection(null)
      void restoreSession(false)
    }
    wallet.multichain?.on('wallet_sessionChanged', onSessionChanged)
    wallet.zcash.on('accountsChanged', onAccountsChanged)
    wallet.ethereum?.on('accountsChanged', onAccountsChanged)
    wallet.ethereum?.on('chainChanged', onChainChanged)
    void restoreSession()
    return () => {
      connectionRevision.current += 1
      epoch.current += 1
      lookupRevision.current += 1
      wallet.multichain?.removeListener('wallet_sessionChanged', onSessionChanged)
      wallet.zcash.removeListener('accountsChanged', onAccountsChanged)
      wallet.ethereum?.removeListener('accountsChanged', onAccountsChanged)
      wallet.ethereum?.removeListener('chainChanged', onChainChanged)
    }
  }, [
    wallet.multichain,
    wallet.zcash,
    wallet.ethereum,
    appendTrace,
    adoptConnection,
    restoreSession
  ])

  useEffect(() => {
    if (client) void refreshAssets()
  }, [client, connection?.accounts, refreshAssets])

  useEffect(() => {
    if (account?.status !== 'activating') return
    let cancelled = false
    let pending = false
    const currentEpoch = epoch.current
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        if (!cancelled && currentEpoch === epoch.current) await refreshAssets()
      } catch (cause) {
        if (!cancelled && currentEpoch === epoch.current) setError(errorMessage(cause))
      } finally {
        pending = false
      }
    }
    const timer = window.setInterval(() => void poll(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [account?.status, account?.address, refreshAssets])

  const runAction = async (name: string, action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(name)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const connect = () =>
    runAction('connect', async () => {
      if (!wallet.multichain) throw new Error('Multichain provider is unavailable.')
      const revision = ++connectionRevision.current
      const chain = selectedChainRef.current
      const evmChainId = wallet.ethereum
        ? await wallet.ethereum.request<string>({ method: 'eth_chainId' })
        : null
      assertPublicMainnet(evmChainId)
      const scopes =
        chain === 'auto'
          ? autoPublicScopes(evmChainId)
          : [chain === 'evm' ? evmPublicScope(evmChainId) : zcashPublicScope('mainnet')]
      if (revision !== connectionRevision.current) return
      const session = await traced(
        'createSession',
        () => wallet.multichain!.createSession(buildPublicSessionRequest(scopes)),
        () => 'connected'
      ).catch((cause: unknown) => {
        if (revision === connectionRevision.current) setError(publicConnectErrorMessage(cause))
        return null
      })
      if (!session || revision !== connectionRevision.current) return
      if (chain === 'auto') {
        await restoreSession()
        return
      }
      const scope = scopes[0]
      const next = readPublicConnection(session, scope)
      if (!next) throw new Error('The selected chain was not authorized.')
      selectedScopeRef.current = scope
      adoptConnection(next)
    })

  const disconnect = () =>
    runAction('disconnect', async () => {
      if (!wallet.multichain) return
      const revision = ++connectionRevision.current
      await traced('revokeSession', () => wallet.multichain!.revokeSession())
      if (revision === connectionRevision.current) adoptConnection(null)
    })

  const readPublicKey = async (): Promise<void> => {
    const signer = accountRef.current
    if (!signer || !client) return
    const currentEpoch = epoch.current
    const key = await traced('getPublicKey', () => client.getPublicKey())
    if (currentEpoch !== epoch.current) return
    if (
      !key ||
      key.pubkey.toLowerCase() !== signer.publicKey.toLowerCase() ||
      key.address !== signer.address ||
      key.signingMode !== signer.signingMode
    ) {
      throw new Error('Public signing identity changed.')
    }
    setPublicKey(key.pubkey)
  }

  const getPublicKey = () => runAction('public-key', readPublicKey)

  const sign = (event: FormEvent) => {
    event.preventDefault()
    void runAction('sign', async () => {
      const signer = accountRef.current
      if (!signer || !signingMessage || !client) return
      const currentEpoch = epoch.current
      setSigningResult(null)
      await readPublicKey()
      if (currentEpoch !== epoch.current) return
      const signed = await traced('signMessage', () => client.signMessage(signingMessage))
      if (currentEpoch !== epoch.current) return
      const verification =
        signer.chain === 'evm'
          ? {
              valid:
                /^0x[0-9a-f]{130}$/i.test(signed.signature) &&
                (await verifyMessage({
                  address: signer.address as `0x${string}`,
                  message: signingMessage,
                  signature: signed.signature as `0x${string}`
                })),
              error: 'Invalid EVM signature'
            }
          : verifyMessageSignature({
              message: signingMessage,
              signature: signed.signature,
              pubkey: signer.publicKey,
              address: signer.address,
              network: signer.network
            })
      if (currentEpoch !== epoch.current) return
      const verified =
        verification.valid &&
        signed.pubkey.toLowerCase() === signer.publicKey.toLowerCase() &&
        signed.address === signer.address &&
        signed.signingMode === signer.signingMode
      setSigningResult({ signature: signed.signature, verified, error: verification.error })
    })
  }

  const refresh = () =>
    runAction('refresh', async () => {
      await restoreSession()
    })

  const activate = () =>
    runAction('activate', async () => {
      if (!client) return
      const currentEpoch = epoch.current
      const next = await traced(
        'activatePublicAccount',
        () => client.activatePublicAccount(),
        value => value.status
      )
      if (currentEpoch === epoch.current) adoptAccount(next)
    })

  const transferAssets = useMemo(() => supportedTransferAssets(assets?.assets ?? []), [assets])
  const selectedAsset = transferAssets.find(asset => asset.tokenId === tokenId) ?? transferAssets[0]

  const send = (event: FormEvent) => {
    event.preventDefault()
    void runAction('send', async () => {
      if (!client) return
      if (accountRef.current?.status !== 'active')
        throw new Error('Activate the Public account first.')
      let submitted = intentRef.current
      if (!submitted) {
        const txRequests =
          mode === 'transfer'
            ? selectedAsset
              ? buildTransferRequest(selectedAsset, recipient, amount)
              : (() => {
                  throw new Error('No supported asset is available.')
                })()
            : parseRequests(requests)
        submitted = { requestId: requestId.trim(), txRequests }
        if (!submitted.requestId) throw new Error('Enter a request ID.')
        // Freeze the exact pair before the SDK request; response loss must not create a new operation.
        intentRef.current = submitted
        setIntent(submitted)
      }
      const currentEpoch = epoch.current
      const result = await traced(
        'sendPublicTransaction',
        () => client.sendPublicTransaction(submitted),
        value => value.status
      )
      if (currentEpoch !== epoch.current) return
      lookupRevision.current += 1
      setOperationId(result.operationId)
      setTransaction(result)
      setLookupAttempted(true)
      if (result.status === 'final') void refreshAssets(true)
    })
  }

  const newIntent = () => {
    intentRef.current = null
    setIntent(null)
    setRequestId(crypto.randomUUID())
    setError(null)
  }

  const lookup = useCallback(
    async (id: string) => {
      if (!id.trim() || !client) return
      const currentEpoch = epoch.current
      const currentRevision = lookupRevision.current
      if (lookupBusyRevision.current === currentRevision) return
      lookupBusyRevision.current = currentRevision
      setLookupAttempted(true)
      try {
        const result = await traced(
          'getPublicTransaction',
          () => client.getPublicTransaction(id.trim()),
          value => value?.status
        )
        if (currentEpoch !== epoch.current || currentRevision !== lookupRevision.current) return
        setTransaction(result)
        if (result?.status === 'final') void refreshAssets(true)
      } catch (cause) {
        if (currentEpoch === epoch.current && currentRevision === lookupRevision.current)
          setError(errorMessage(cause))
      } finally {
        if (lookupBusyRevision.current === currentRevision) lookupBusyRevision.current = null
      }
    },
    [client, traced, refreshAssets]
  )

  useEffect(() => {
    if (
      !operationId ||
      !account ||
      transaction?.status === 'final' ||
      transaction?.status === 'failed'
    )
      return
    const timer = window.setInterval(() => void lookup(operationId), 5000)
    return () => window.clearInterval(timer)
  }, [operationId, account?.address, transaction?.status, lookup])

  return (
    <div className="tab-panel grid-2 public-example public-demo">
      <section className="card card-compact public-demo-account">
        <div className="card-header">
          <h2>Protocol account</h2>
          <div className="public-account-actions">
            {connection ? (
              <>
                <button
                  className="btn btn-secondary btn-xs"
                  onClick={() => void refresh()}
                  disabled={!!busy || assetsBusy}
                >
                  Refresh
                </button>
                <button
                  className="btn btn-danger btn-xs"
                  onClick={() => void disconnect()}
                  disabled={!!busy}
                >
                  Disconnect
                </button>
              </>
            ) : null}
          </div>
        </div>
        {!connection && (
          <div className="public-demo-connect-controls">
            <label className="label" htmlFor="public-chain">
              Connection chain
            </label>
            <select
              id="public-chain"
              className="input"
              value={selectedChain}
              disabled={!!busy || restoring}
              onChange={event => {
                const chain = event.target.value as PublicChain
                connectionRevision.current += 1
                selectedChainRef.current = chain
                selectedScopeRef.current = null
                setSelectedChain(chain)
                adoptConnection(null)
                setRestoring(true)
                void restoreSession()
              }}
            >
              <option value="auto">Auto</option>
              {wallet.ethereum && <option value="evm">EVM</option>}
              <option value="zcash">Zcash</option>
            </select>
            <button
              className="btn btn-primary btn-xs"
              onClick={() => void connect()}
              disabled={!!busy || restoring || !wallet.multichain}
            >
              {busy === 'connect' ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        )}
        {connection && (
          <div className="public-demo-facts">
            <div>
              <span>Chain</span>
              <strong>{connection.chain === 'evm' ? 'EVM' : 'Zcash'}</strong>
            </div>
            <div>
              <span>Scope</span>
              <code>{connection.scope}</code>
            </div>
            <div>
              <span>Account</span>
              <div className="public-demo-account-list">
                {connection.accounts.map(value => (
                  <code key={value}>{value}</code>
                ))}
              </div>
            </div>
            <div>
              <span>Connection</span>
              <strong>Connected</strong>
            </div>
          </div>
        )}
        {connection &&
          (account ? (
            <div className="public-demo-facts" data-testid="public-account">
              <div>
                <span>Status</span>
                <strong data-testid="public-status">{account.status}</strong>
              </div>
              <div>
                <span>Network</span>
                <strong>{account.network}</strong>
              </div>
              <div>
                <span>Address</span>
                <code>{account.address}</code>
              </div>
              <div>
                <span>Signing mode</span>
                <strong>{account.signingMode}</strong>
              </div>
              <div>
                <span>MCA ID</span>
                <code>{account.mcaId ?? 'Not active'}</code>
              </div>
              <div>
                <span>Parent contract</span>
                <code>{account.parentContractId}</code>
              </div>
              {account.activationId && (
                <div>
                  <span>Activation ID</span>
                  <code>{account.activationId}</code>
                </div>
              )}
            </div>
          ) : (
            <p className="message">
              {restoring ? 'Checking connection...' : 'Protocol account unavailable.'}
            </p>
          ))}
        {account?.status === 'inactive' && (
          <button className="btn btn-primary" onClick={() => void activate()} disabled={!!busy}>
            {busy === 'activate' ? 'Activating...' : 'Activate public account'}
          </button>
        )}
        {error && (
          <div className="message error public-demo-error" role="alert">
            {error}
          </div>
        )}
      </section>

      {connection && (
        <>
          <section className="card card-compact public-demo-assets">
            <div className="card-header">
              <h2>Assets</h2>
              {assetsBusy && <span className="public-demo-muted">Refreshing...</span>}
            </div>
            {assets?.assets.length ? (
              <div className="public-demo-asset-list">
                {assets.assets.map(asset => (
                  <div className="public-demo-asset" key={asset.tokenId}>
                    <div>
                      <strong>{displayAssetSymbol(asset)}</strong>
                      <small>{asset.tokenId === 'wrap.near' ? 'NEAR' : asset.name}</small>
                    </div>
                    <div className="public-demo-asset-value">
                      <strong>{formatAssetBalance(asset)}</strong>
                      <small>{asset.status}</small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="message">{assetsBusy ? 'Loading assets...' : 'No assets available.'}</p>
            )}
          </section>

          <section className="card card-compact grid-span-2 public-demo-signing">
            <div className="card-header">
              <h2>Public signing</h2>
            </div>
            <form onSubmit={sign}>
              <div className="form-group">
                <label className="label" htmlFor="public-sign-message">
                  Message
                </label>
                <textarea
                  id="public-sign-message"
                  placeholder='{"message":"Sign in"}'
                  className="input textarea-sm"
                  value={signingMessage}
                  onChange={event => {
                    setSigningMessage(event.target.value)
                    setSigningResult(null)
                  }}
                />
              </div>
              <div className="public-demo-actions">
                <button
                  className="btn btn-secondary btn-xs"
                  type="button"
                  onClick={() => void getPublicKey()}
                  disabled={!account || !!busy}
                >
                  Get public key
                </button>
                <button
                  className="btn btn-primary btn-xs"
                  type="submit"
                  disabled={!account || !signingMessage || !!busy}
                >
                  {busy === 'sign' ? 'Signing...' : 'Sign message'}
                </button>
              </div>
            </form>
            {publicKey && (
              <div className="public-demo-facts public-demo-signing-result">
                <div>
                  <span>Public key</span>
                  <code>{publicKey}</code>
                </div>
              </div>
            )}
            {signingResult && (
              <div className="public-demo-facts public-demo-signing-result">
                <div>
                  <span>Verification</span>
                  <strong>
                    {signingResult.verified
                      ? 'Valid for this Public identity'
                      : (signingResult.error ?? 'Failed')}
                  </strong>
                </div>
                <div>
                  <span>Signature</span>
                  <code>{signingResult.signature}</code>
                </div>
              </div>
            )}
          </section>

          <section className="card card-compact grid-span-2 public-demo-compose">
            <div className="card-header">
              <h2>Transaction</h2>
              <div className="public-demo-segmented" role="group" aria-label="Request type">
                <button
                  type="button"
                  className={mode === 'transfer' ? 'active' : ''}
                  onClick={() => setMode('transfer')}
                  disabled={!!intent}
                >
                  Token transfer
                </button>
                <button
                  type="button"
                  className={mode === 'function' ? 'active' : ''}
                  onClick={() => setMode('function')}
                  disabled={!!intent}
                >
                  FunctionCall
                </button>
              </div>
            </div>
            <form onSubmit={send}>
              {mode === 'transfer' ? (
                <div className="public-demo-form-grid">
                  <div className="form-group">
                    <label className="label" htmlFor="public-token">
                      Asset
                    </label>
                    <select
                      id="public-token"
                      className="input"
                      value={selectedAsset?.tokenId ?? ''}
                      onChange={event => setTokenId(event.target.value)}
                      disabled={!!intent}
                    >
                      {transferAssets.map(asset => (
                        <option key={asset.tokenId} value={asset.tokenId}>
                          {displayAssetSymbol(asset)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="label" htmlFor="public-recipient">
                      Recipient NEAR account
                    </label>
                    <input
                      id="public-recipient"
                      className="input"
                      value={recipient}
                      onChange={event => setRecipient(event.target.value)}
                      disabled={!!intent}
                    />
                  </div>
                  <div className="form-group">
                    <label className="label" htmlFor="public-amount">
                      Amount
                    </label>
                    <div className="public-demo-amount">
                      <input
                        id="public-amount"
                        className="input"
                        inputMode="decimal"
                        value={amount}
                        onChange={event => setAmount(event.target.value)}
                        disabled={!!intent}
                      />
                      <span>{selectedAsset ? displayAssetSymbol(selectedAsset) : 'Token'}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="form-group">
                  <label className="label" htmlFor="public-requests">
                    Transaction requests
                  </label>
                  <textarea
                    id="public-requests"
                    className="textarea public-request-editor"
                    spellCheck={false}
                    value={requests}
                    onChange={event => setRequests(event.target.value)}
                    disabled={!!intent}
                  />
                </div>
              )}
              <div className="form-group">
                <label className="label" htmlFor="public-request-id">
                  Request ID
                </label>
                <input
                  id="public-request-id"
                  className="input"
                  value={requestId}
                  onChange={event => setRequestId(event.target.value)}
                  disabled={!!intent}
                  required
                />
              </div>
              <div className="public-demo-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={!!busy || account?.status !== 'active'}
                >
                  {busy === 'send'
                    ? 'Sending...'
                    : intent
                      ? 'Retry same request'
                      : 'Send public transaction'}
                </button>
                {intent && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={newIntent}
                    disabled={!!busy}
                  >
                    New intent
                  </button>
                )}
              </div>
            </form>
          </section>
          <section className="card card-compact public-demo-transaction">
            <h2>Transaction status</h2>
            <div className="form-group">
              <label className="label" htmlFor="public-operation-id">
                Operation ID
              </label>
              <div className="public-demo-lookup">
                <input
                  id="public-operation-id"
                  className="input"
                  value={operationId}
                  onChange={event => {
                    lookupRevision.current += 1
                    setOperationId(event.target.value)
                    setTransaction(null)
                    setLookupAttempted(false)
                  }}
                />
                <button
                  className="btn btn-secondary btn-xs"
                  onClick={() => void lookup(operationId)}
                  disabled={!operationId.trim() || !!busy}
                >
                  Check status
                </button>
              </div>
            </div>
            {transaction && (
              <div className="public-demo-facts public-demo-tx-facts">
                <div>
                  <span>Status</span>
                  <strong>{transaction.status}</strong>
                </div>
                {transaction.transactionHash && (
                  <div>
                    <span>Transaction hash</span>
                    <code>{transaction.transactionHash}</code>
                  </div>
                )}
                {transaction.submissionId && (
                  <div>
                    <span>Submission ID</span>
                    <code>{transaction.submissionId}</code>
                  </div>
                )}
                {transaction.anchor && (
                  <div>
                    <span>Anchor</span>
                    <strong>{transaction.anchor.status}</strong>
                  </div>
                )}
                {transaction.error && <p className="message error">{transaction.error}</p>}
                <details>
                  <summary>Response</summary>
                  <pre>{JSON.stringify(transaction, null, 2)}</pre>
                </details>
              </div>
            )}
            {lookupAttempted && !transaction && !error && (
              <p className="message">No transaction found.</p>
            )}
          </section>
        </>
      )}
      <section className="card card-compact public-demo-trace">
        <div className="card-header">
          <h2>SDK trace</h2>
          <button
            className="btn btn-secondary btn-xs"
            onClick={() => exportTrace(trace, walletVersion)}
            disabled={!trace.length}
          >
            Export trace
          </button>
        </div>
        <ol className="public-demo-trace-list">
          {trace
            .slice(-8)
            .reverse()
            .map(entry => (
              <li key={entry.sequence}>
                <span className={`public-demo-trace-dot ${entry.outcome}`} />
                <code>{entry.method}</code>
                <span>
                  #{entry.callId ?? entry.sequence} {entry.outcome}
                  {entry.status ? ` · ${entry.status}` : ''}
                  {entry.code !== undefined ? ` · ${entry.code}` : ''}
                </span>
                {entry.elapsedMs !== undefined && <small>{entry.elapsedMs} ms</small>}
              </li>
            ))}
        </ol>
      </section>
      <div className="public-demo-build grid-span-2">
        <span>Example {build?.exampleVersion ?? 'unknown'}</span>
        <span>SDK {build?.sdkVersion ?? 'unknown'}</span>
        <span>Wallet {walletVersion ?? 'unknown'}</span>
        <span>Revision {build?.revision ?? 'unknown'}</span>
      </div>
    </div>
  )
}
