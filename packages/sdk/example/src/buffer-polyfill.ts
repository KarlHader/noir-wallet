/**
 * bitcoinjs-lib and related packages read the global Buffer at runtime.
 * Import this module first so the assignment runs before those packages load.
 */
import { Buffer } from 'buffer'

const scope = globalThis as typeof globalThis & { Buffer: typeof Buffer }
scope.Buffer = Buffer
