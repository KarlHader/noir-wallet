interface WasmWorkerRuntime {
  Window?: unknown
  window?: unknown
  fetch: typeof globalThis.fetch
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  performance: Performance
}

/** Supply the Window APIs requested by voting WASM inside the dedicated worker. */
export function installWasmWorkerWindowCompatibility(runtime: WasmWorkerRuntime): void {
  if (runtime.window != null) return
  if (
    typeof runtime.fetch !== 'function' ||
    typeof runtime.setTimeout !== 'function' ||
    typeof runtime.clearTimeout !== 'function' ||
    typeof runtime.performance?.now !== 'function'
  ) {
    throw new Error('Voting WASM requires Worker fetch, timers, and performance APIs')
  }

  const WasmWorkerWindow = function WasmWorkerWindow() {}
  let compatibilityWindow: object
  Object.defineProperty(WasmWorkerWindow, Symbol.hasInstance, {
    value: (candidate: unknown) => candidate === runtime || candidate === compatibilityWindow
  })
  compatibilityWindow = Object.freeze(
    Object.assign(Object.create(WasmWorkerWindow.prototype), {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => runtime.fetch(input, init),
      setTimeout: (...args: Parameters<WasmWorkerRuntime['setTimeout']>) =>
        runtime.setTimeout(...args),
      clearTimeout: (handle: number | undefined) => runtime.clearTimeout(handle),
      performance: runtime.performance
    })
  )

  Object.defineProperty(runtime, 'Window', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: WasmWorkerWindow
  })
  Object.defineProperty(runtime, 'window', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: compatibilityWindow
  })
}
