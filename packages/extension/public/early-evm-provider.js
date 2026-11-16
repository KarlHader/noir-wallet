// This classic content script runs before the HMR module loader so dApps can
// discover the provider while the full wallet code is still loading.
;(() => {
  if (window.__noirEarlyEvmProvider) return

  const fallback = window.__noirFallbackEvmProvider
  let delegate = fallback?.provider ?? null
  const listeners = new Map()
  const pending = new Set()
  const provider =
    fallback?.provider ??
    Object.freeze({
      isNoirWallet: true,
      get selectedAddress() {
        return delegate?.selectedAddress ?? null
      },
      get chainId() {
        return delegate?.chainId ?? null
      },
      request(args) {
        if (delegate) return delegate.request(args)
        return new Promise((resolve, reject) => {
          const waiting = { args, resolve, reject, timer: 0 }
          waiting.timer = setTimeout(() => {
            pending.delete(waiting)
            const error = new Error('Noir Wallet provider did not initialize.')
            error.code = 4900
            reject(error)
          }, 30_000)
          pending.add(waiting)
        })
      },
      on(event, handler) {
        if (typeof event !== 'string' || typeof handler !== 'function') {
          throw new TypeError('Provider event and handler are required.')
        }
        const handlers = listeners.get(event) ?? new Set()
        handlers.add(handler)
        listeners.set(event, handlers)
        delegate?.on(event, handler)
        return provider
      },
      removeListener(event, handler) {
        listeners.get(event)?.delete(handler)
        delegate?.removeListener(event, handler)
        return provider
      },
      isConnected() {
        return delegate?.isConnected() ?? false
      }
    })
  const info =
    fallback?.info ??
    Object.freeze({
      uuid: crypto.randomUUID(),
      name: 'Noir Wallet',
      icon: 'data:image/png;base64,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',
      rdns: '__NOIR_WALLET_RDNS__'
    })
  const detail = Object.freeze({ info, provider })
  const announce = () => {
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
  }

  Object.defineProperty(window, '__noirEarlyEvmProvider', {
    value: Object.freeze({
      provider,
      info,
      attach(next) {
        if (delegate) return
        delegate = next
        for (const [event, handlers] of listeners) {
          for (const handler of handlers) next.on(event, handler)
        }
        for (const waiting of pending) {
          clearTimeout(waiting.timer)
          next.request(waiting.args).then(waiting.resolve, waiting.reject)
        }
        pending.clear()
      }
    }),
    configurable: false
  })
  window.addEventListener('eip6963:requestProvider', announce)
  installLegacyRouter()
  announce()

  function installLegacyRouter() {
    const alternatives = new Map()
    const legacyAlternatives = new Map()
    const announcedProviders = new WeakSet()
    const requests = new Map()
    const handlers = new Map()
    const subscriptions = new Map()
    let preference = null
    let selected = null
    let selection = null
    let observedChainId = null
    let selectionEpoch = 0
    let chainRevision = 0
    let selectedChainObserver = null
    let router
    let resolveConfig
    let rejectConfig
    const configured = new Promise((resolve, reject) => {
      resolveConfig = resolve
      rejectConfig = reject
    })
    // Startup failure is reported to a caller, even if no dApp has requested a connection yet.
    void configured.catch(() => {})

    function rpcError(message, code = 4001) {
      return Object.assign(new Error(message), { code })
    }

    function availableAlternatives() {
      return alternatives.size > 0 ? alternatives : legacyAlternatives
    }

    function capture(candidate, metadata, announced = false) {
      try {
        if (!candidate || candidate === provider || candidate === router) return
        if (typeof candidate.request !== 'function') return
        const previous = alternatives.get(candidate) ?? legacyAlternatives.get(candidate)
        const brand = candidate.isRabby
          ? 'Rabby Wallet'
          : candidate.isOkxWallet || candidate.isOKExWallet
            ? 'OKX Wallet'
            : candidate.isPhantom
              ? 'Phantom'
              : candidate.isCoinbaseWallet || candidate.isCoinbaseBrowser
                ? 'Coinbase Wallet'
                : null
        const declaredName =
          typeof metadata?.name === 'string' && metadata.name.trim()
            ? metadata.name.trim().slice(0, 80)
            : null
        const name = declaredName ?? brand
        if (!name) {
          // isMetaMask is a compatibility flag used by Phantom and other routers too.
          // An unidentified global is only a fallback when no named wallet is discoverable.
          if (!previous && legacyAlternatives.size < 19) {
            legacyAlternatives.set(candidate, {
              id: `wallet-${crypto.randomUUID()}`,
              name: 'Other wallet'
            })
          }
          return
        }
        legacyAlternatives.delete(candidate)
        // A wallet can expose a namespace proxy and a different EIP-6963 object.
        // Prefer announced providers over those legacy aliases, retaining distinct announcements.
        if (announced) {
          announcedProviders.add(candidate)
          for (const [alias, option] of alternatives) {
            if (!announcedProviders.has(alias) && option.name === name) alternatives.delete(alias)
          }
        } else if (
          [...alternatives].some(
            ([entry, option]) => announcedProviders.has(entry) && option.name === name
          )
        )
          return
        const rawIcon = typeof metadata?.icon === 'string' ? metadata.icon.trim() : undefined
        const icon =
          rawIcon &&
          rawIcon.length <= 131_072 &&
          /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(rawIcon)
            ? rawIcon
            : undefined
        if (!previous && alternatives.size >= 19) return
        alternatives.set(candidate, {
          id: previous?.id ?? `wallet-${crypto.randomUUID()}`,
          name,
          ...(icon || previous?.icon ? { icon: icon ?? previous.icon } : {})
        })
      } catch {
        // An unrelated extension's accessor must not break Noir's independent provider.
      }
    }

    function discover() {
      for (const [read, name] of [
        [() => window.ethereum],
        [() => window.okxwallet, 'OKX Wallet'],
        [() => window.rabby, 'Rabby Wallet'],
        [() => window.coinbaseWalletExtension, 'Coinbase Wallet'],
        [() => window.phantom?.ethereum, 'Phantom']
      ]) {
        try {
          const candidate = read()
          capture(candidate, name ? { name } : undefined)
          if (Array.isArray(candidate?.providers))
            candidate.providers.forEach(item => capture(item))
        } catch {}
      }
      window.dispatchEvent(new Event('eip6963:requestProvider'))
    }

    function bridge(type, extra = {}, timeout = 125_000) {
      const requestId = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          requests.delete(requestId)
          reject(rpcError('Wallet selection timed out. Reload the website and try again.', 4900))
        }, timeout)
        requests.set(requestId, { resolve, reject, timer })
        window.postMessage(
          { target: 'noir-content-script', type, requestId, ...extra },
          window.location.origin
        )
      })
    }

    window.addEventListener('message', event => {
      if (event.source !== window || event.data?.target !== 'noir-evm-wallet-router') return
      const waiting = requests.get(event.data.requestId)
      if (!waiting) return
      requests.delete(event.data.requestId)
      clearTimeout(waiting.timer)
      const response = event.data.response
      if (!response || typeof response !== 'object') {
        waiting.reject(rpcError('Wallet selection is unavailable.', 4900))
      } else if (typeof response.error === 'string') {
        waiting.reject(rpcError(response.error))
      } else {
        waiting.resolve(response.result)
      }
    })
    window.addEventListener('eip6963:announceProvider', event => {
      if (event.detail?.provider !== provider)
        capture(event.detail?.provider, event.detail?.info, true)
    })

    function subscribe(candidate, event, callback) {
      if (typeof candidate?.on !== 'function') return
      const epoch = selectionEpoch
      const forwarded = (...args) => {
        if (selected === candidate && selectionEpoch === epoch) callback(...args)
      }
      const callbacks = subscriptions.get(event) ?? new Map()
      callbacks.set(callback, forwarded)
      subscriptions.set(event, callbacks)
      candidate.on(event, forwarded)
    }

    function unsubscribe(candidate, event, callback) {
      const callbacks = subscriptions.get(event)
      const forwarded = callbacks?.get(callback)
      if (!forwarded) return
      candidate?.removeListener?.(event, forwarded)
      callbacks.delete(callback)
      if (callbacks.size === 0) subscriptions.delete(event)
    }

    function use(candidate) {
      if (selected === candidate) return candidate
      selected?.removeListener?.('chainChanged', selectedChainObserver)
      for (const [event, callbacks] of handlers) {
        for (const callback of callbacks) unsubscribe(selected, event, callback)
      }
      selected = candidate
      selectionEpoch += 1
      const epoch = selectionEpoch
      selectedChainObserver = chainId => {
        if (selected === candidate && selectionEpoch === epoch && typeof chainId === 'string') {
          observedChainId = chainId
          chainRevision += 1
        }
      }
      selected?.on?.('chainChanged', selectedChainObserver)
      for (const [event, callbacks] of handlers) {
        for (const callback of callbacks) subscribe(selected, event, callback)
      }
      return candidate
    }

    async function syncSelectedChain(candidate) {
      if (observedChainId === null) return candidate
      const epoch = selectionEpoch
      const revision = chainRevision
      try {
        const chainId = await candidate.request({ method: 'eth_chainId' })
        if (epoch !== selectionEpoch || revision !== chainRevision || typeof chainId !== 'string')
          return candidate
        if (chainId !== observedChainId) {
          observedChainId = chainId
          chainRevision += 1
          for (const callback of handlers.get('chainChanged') ?? []) {
            try {
              callback(chainId)
            } catch {}
          }
        }
      } catch {
        // A failed chain read must not turn a valid wallet choice into a failed connection.
      }
      return candidate
    }

    function choose() {
      if (selection) return selection
      discover()
      const choices = new Map([
        ...(preference === 'other'
          ? []
          : [[provider, { id: 'noir', name: info.name, icon: info.icon }]]),
        ...availableAlternatives()
      ])
      if (choices.size === 0) {
        return Promise.reject(
          rpcError('No other EVM wallet was found. Refresh and try again.', 4900)
        )
      }
      const choice =
        choices.size === 1
          ? Promise.resolve(choices.keys().next().value)
          : bridge('NOIR_EVM_WALLET_CHOICE', { wallets: [...choices.values()] }).then(id => {
              const match = [...choices].find(([, option]) => option.id === id)
              if (!match) throw rpcError('Choose an available wallet.')
              return match[0]
            })
      selection = choice
        .then(candidate => syncSelectedChain(use(candidate)))
        .finally(() => {
          selection = null
        })
      return selection
    }

    const connectionMethods = new Set(['eth_requestAccounts', 'wallet_requestPermissions'])
    const interactiveMethods = new Set([
      'personal_sign',
      'eth_sign',
      'eth_sendTransaction',
      'eth_sendRawTransaction',
      'eth_signTransaction',
      'eth_signTypedData',
      'eth_signTypedData_v1',
      'eth_signTypedData_v3',
      'eth_signTypedData_v4',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'wallet_watchAsset',
      'wallet_sendCalls',
      'wallet_grantPermissions',
      'wallet_revokePermissions'
    ])
    async function request(args) {
      if (!args || typeof args.method !== 'string' || args.method.length === 0) {
        throw rpcError('A provider method is required.', -32600)
      }
      await configured
      const pendingSelection = selection
      let target = pendingSelection ? await pendingSelection : selected
      if (preference === 'noir') target = use(provider)
      else if (
        (connectionMethods.has(args.method) && !pendingSelection) ||
        (!target && interactiveMethods.has(args.method))
      ) {
        target = await choose()
      } else if (!target) {
        if (args.method === 'eth_accounts' || args.method === 'wallet_getPermissions') return []
        discover()
        target = preference === 'other' ? availableAlternatives().keys().next().value : provider
      }
      if (!target) throw rpcError('No other EVM wallet was found. Refresh and try again.', 4900)
      const epoch = selectionEpoch
      const revision = chainRevision
      const result = await target.request(args)
      if (args.method === 'eth_chainId' && typeof result === 'string') {
        if (epoch !== selectionEpoch && selected) return request(args)
        if (revision !== chainRevision) return observedChainId
        observedChainId = result
      }
      return result
    }

    function on(event, callback) {
      if (typeof event !== 'string' || typeof callback !== 'function') {
        throw new TypeError('Provider event and handler are required.')
      }
      const callbacks = handlers.get(event) ?? new Set()
      if (!callbacks.has(callback)) subscribe(selected, event, callback)
      callbacks.add(callback)
      handlers.set(event, callbacks)
      return router
    }
    function removeListener(event, callback) {
      if (handlers.get(event)?.delete(callback)) unsubscribe(selected, event, callback)
      return router
    }
    function sendAsync(payload, callback) {
      if (typeof callback !== 'function') throw new TypeError('A callback is required.')
      void request(payload).then(
        result => callback(null, { id: payload.id, jsonrpc: payload.jsonrpc ?? '2.0', result }),
        error => callback(error, null)
      )
    }
    const methods = {
      request,
      on,
      addListener: on,
      removeListener,
      off: removeListener,
      once(event, callback) {
        const once = value => {
          removeListener(event, once)
          callback(value)
        }
        return on(event, once)
      },
      removeAllListeners(event) {
        for (const name of event === undefined ? [...handlers.keys()] : [event]) {
          for (const callback of handlers.get(name) ?? []) removeListener(name, callback)
          handlers.delete(name)
        }
        return router
      },
      enable: () => request({ method: 'eth_requestAccounts' }),
      sendAsync,
      send(method, params) {
        return typeof method === 'string' ? request({ method, params }) : sendAsync(method, params)
      }
    }
    router = new Proxy(
      {},
      {
        get(_target, key) {
          if (Object.prototype.hasOwnProperty.call(methods, key)) return methods[key]
          if (key === 'providers') return [provider, ...availableAlternatives().keys()]
          if (key === 'selectedAddress' && !selected && preference !== 'noir') return null
          const target =
            selected ??
            (preference === 'other' ? availableAlternatives().keys().next().value : provider)
          if (!target || key === 'then') return undefined
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }
    )

    function install() {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(window, 'ethereum')
        if (descriptor?.get === legacyGetter) return
        capture(window.ethereum)
        if (!descriptor || descriptor.configurable) {
          // Other wallets lock this shared entry. A stable getter preserves the user's
          // routing preference while still yielding other providers in 'other' mode.
          Object.defineProperty(window, 'ethereum', {
            get: legacyGetter,
            set: candidate => capture(candidate),
            configurable: false,
            enumerable: true
          })
        } else if (descriptor.writable) {
          window.ethereum = preference === 'other' ? legacyGetter() : router
        }
      } catch {}
    }
    function legacyGetter() {
      if (preference !== 'other') return router
      const others = availableAlternatives()
      return others.size > 1 ? router : (selected ?? others.keys().next().value)
    }
    install()

    let configStarted = false
    function configure() {
      if (configStarted) return
      configStarted = true
      void bridge('NOIR_EVM_WALLET_CONFIG', {}, 10_000)
        .then(value => {
          if (value !== 'ask' && value !== 'noir' && value !== 'other') {
            throw rpcError('Wallet preference could not be loaded.', 4900)
          }
          preference = value
          discover()
          install()
          resolveConfig()
        })
        .catch(rejectConfig)
    }
    window.addEventListener('noirwallet#bridgeReady', configure)
    window.dispatchEvent(new Event('noirwallet#requestBridgeReady'))
    window.addEventListener(
      'pagehide',
      () => {
        for (const waiting of requests.values()) {
          clearTimeout(waiting.timer)
          waiting.reject(rpcError('The website changed. Connect again.'))
        }
        requests.clear()
      },
      { once: true }
    )
  }
})()
