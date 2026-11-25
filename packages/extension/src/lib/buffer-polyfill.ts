/**
 * Bitcoin and BC-UR dependencies read the global Buffer at
 * runtime; browsers don't provide it. This must run before those modules are
 * evaluated, so import it first (ESM executes imports in declaration order).
 */
import { Buffer } from 'buffer'

// Vite's dev prebundling leaves the browser build of randombytes reading `global.crypto`.
// Node already has `global` but does not provide Vite's import.meta.env.
if (typeof global === 'undefined' && import.meta.env.DEV) {
  Object.defineProperty(globalThis, 'global', {
    configurable: true,
    writable: true,
    value: globalThis
  })
}

// Force our single `buffer` build onto the global. The UR libraries read the
// global `Buffer` and check values with `instanceof`; a conditional assignment
// would let another bundled `buffer` copy win the global first and reintroduce
// cross-copy `instanceof` mismatches.
globalThis.Buffer = Buffer

if (typeof globalThis.process === 'undefined') {
  Object.defineProperty(globalThis, 'process', {
    configurable: true,
    writable: true,
    value: {
      browser: true,
      env: {},
      version: '',
      nextTick<Args extends unknown[]>(callback: (...args: Args) => void, ...args: Args) {
        queueMicrotask(() => callback(...args))
      }
    }
  })
}
