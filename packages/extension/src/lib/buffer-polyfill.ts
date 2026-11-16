/**
 * Bitcoin and BC-UR dependencies read the global Buffer at
 * runtime; browsers don't provide it. This must run before those modules are
 * evaluated, so import it first (ESM executes imports in declaration order).
 */
import { Buffer } from 'buffer'

// Force our single `buffer` build onto the global. The UR libraries read the
// global `Buffer` and check values with `instanceof`; a conditional assignment
// would let another bundled `buffer` copy win the global first and reintroduce
// cross-copy `instanceof` mismatches.
globalThis.Buffer = Buffer
