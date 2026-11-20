/* @ts-self-types="./zcash_wallet_wasm.d.ts" */
import { startWorkers } from './snippets/wasm-bindgen-rayon-38edf6e439f6d70d/src/workerHelpers.js'

export class BlockRange {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    BlockRangeFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_blockrange_free(ptr, 0)
  }
  /**
   * @returns {number}
   */
  get 0() {
    const ret = wasm.__wbg_get_blockrange_0(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @returns {number}
   */
  get 1() {
    const ret = wasm.__wbg_get_blockrange_1(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @param {number} arg0
   */
  set 0(arg0) {
    wasm.__wbg_set_blockrange_0(this.__wbg_ptr, arg0)
  }
  /**
   * @param {number} arg0
   */
  set 1(arg0) {
    wasm.__wbg_set_blockrange_1(this.__wbg_ptr, arg0)
  }
}
if (Symbol.dispose) BlockRange.prototype[Symbol.dispose] = BlockRange.prototype.free

/**
 * Canary gate. `phase` is one of `"notStarted"`, `"awaitingArrival"`, `"awaitingSpend"`,
 * `"proven"`; `allows` answers whether a deposit may be started now.
 */
export class Canary {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    CanaryFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_canary_free(ptr, 0)
  }
  /**
   * @param {number} amount
   * @returns {boolean}
   */
  allows(amount) {
    const ret = wasm.canary_allows(this.__wbg_ptr, amount)
    return ret !== 0
  }
  arrival_confirmed() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.canary_arrival_confirmed(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Register the small first deposit.
   * @param {number} amount
   */
  begin(amount) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.canary_begin(retptr, this.__wbg_ptr, amount)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  constructor() {
    const ret = wasm.canary_new()
    this.__wbg_ptr = ret
    CanaryFinalization.register(this, this.__wbg_ptr, this)
    return this
  }
  /**
   * @returns {string}
   */
  phase() {
    let deferred1_0
    let deferred1_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.canary_phase(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      deferred1_0 = r0
      deferred1_1 = r1
      return getStringFromWasm0(r0, r1)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1)
    }
  }
  spend_confirmed() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.canary_spend_confirmed(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Canary.prototype[Symbol.dispose] = Canary.prototype.free

/**
 * Coordinator side of a signing session.
 */
export class Coordinator {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    CoordinatorFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_coordinator_free(ptr, 0)
  }
  /**
   * Collect a `SIGN_COMMITMENTS` envelope from a signer.
   * @param {Uint8Array} envelope
   */
  accept_commitments(envelope) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.coordinator_accept_commitments(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Accept a signer's refusal. The session ends; one signer out means this selection no longer reaches
   * the threshold.
   * @param {Uint8Array} envelope
   * @returns {Array<any>}
   */
  accept_reject(envelope) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.coordinator_accept_reject(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Collect a `SIGN_SHARE` envelope.
   * @param {Uint8Array} envelope
   */
  accept_share(envelope) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.coordinator_accept_share(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {number}
   */
  actions() {
    const ret = wasm.coordinator_actions(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * Aggregate once every signer has returned every share. Returns the signatures, 64 bytes each.
   * @returns {Uint8Array}
   */
  aggregate() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.coordinator_aggregate(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The whole `SIGN_INIT` batch: `[[slot, envelope], ...]`. One call, because the session moves to
   * `InitSent` as a whole.
   * @returns {Array<any>}
   */
  init_all() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.coordinator_init_all(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * `signers` is the selected roster slots (length must equal the threshold).
   * @param {Uint8Array} session_id
   * @param {number} participants
   * @param {number} threshold
   * @param {Uint8Array} signers
   * @param {number} actions
   * @param {Uint8Array} public_key_package
   */
  constructor(session_id, participants, threshold, signers, actions, public_key_package) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(signers, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(public_key_package, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      wasm.coordinator_new(
        retptr,
        ptr0,
        len0,
        participants,
        threshold,
        ptr1,
        len1,
        actions,
        ptr2,
        len2
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      CoordinatorFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The whole `SIGN_PAYLOAD` batch: `[[slot, envelope], ...]`.
   * @returns {Array<any>}
   */
  payloads() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.coordinator_payloads(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {string}
   */
  phase() {
    let deferred1_0
    let deferred1_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.coordinator_phase(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      deferred1_0 = r0
      deferred1_1 = r1
      return getStringFromWasm0(r0, r1)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1)
    }
  }
  /**
   * Hand over the sighash and per-action alphas read from the built transaction.
   * @param {Uint8Array} sighash
   * @param {Uint8Array} alphas
   */
  prepare_payload(sighash, alphas) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(sighash, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(alphas, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.coordinator_prepare_payload(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Report the outcome to every signer after aggregation.
   *
   * `status`: 0 = broadcasted (then `txid` is required), 1 = failed. Returns `[[slot, envelope], ...]`.
   * @param {number} status
   * @param {Uint8Array | null | undefined} txid
   * @param {string} note
   * @returns {Array<any>}
   */
  report_result(status, txid, note) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      var ptr0 = isLikeNone(txid) ? 0 : passArray8ToWasm0(txid, wasm.__wbindgen_export)
      var len0 = WASM_VECTOR_LEN
      const ptr1 = passStringToWasm0(note, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      wasm.coordinator_report_result(retptr, this.__wbg_ptr, status, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Coordinator.prototype[Symbol.dispose] = Coordinator.prototype.free

/**
 * Deposit denomination policy.
 */
export class Deposit {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    DepositFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_deposit_free(ptr, 0)
  }
  /**
   * @returns {number}
   */
  static canary_amount() {
    const ret = wasm.deposit_canary_amount()
    return ret
  }
  /**
   * @returns {number}
   */
  static denom_cap() {
    const ret = wasm.deposit_denom_cap()
    return ret
  }
  /**
   * @param {number} value
   * @returns {boolean}
   */
  static is_canonical(value) {
    const ret = wasm.deposit_is_canonical(value)
    return ret !== 0
  }
  /**
   * Split an amount into canonical outputs. Returns the output values (`Float64Array`) or an error
   * when the amount cannot be sent.
   * @param {number} amount
   * @returns {Float64Array}
   */
  static plan(amount) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.deposit_plan(retptr, amount)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Residual left behind, in zatoshi.
   * @param {number} amount
   * @returns {number}
   */
  static residual(amount) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.deposit_residual(retptr, amount)
      var r0 = getDataViewMemory0().getFloat64(retptr + 8 * 0, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      if (r3) {
        throw takeObject(r2)
      }
      return r0
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Deposit.prototype[Symbol.dispose] = Deposit.prototype.free

/**
 * One device's participation in a distributed key generation.
 */
export class Dkg {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    DkgFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_dkg_free(ptr, 0)
  }
  /**
   * @param {number} participants
   * @param {number} threshold
   * @param {number} slot
   * @param {Uint8Array} session_id
   */
  constructor(participants, threshold, slot, session_id) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.dkg_new(retptr, participants, threshold, slot, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      DkgFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Round 1: generate this device's contribution.
   *
   * The contribution is bound to this ceremony's session id: a later round refuses a broadcast that
   * names a different one, so a round-1 secret cannot be carried into a second ceremony.
   * @returns {Dkg1}
   */
  part1() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.dkg_part1(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return Dkg1.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Round 2: seal one package per peer from everyone's broadcasts.
   * @param {Uint8Array} secret
   * @param {MessageSet} broadcasts
   * @returns {Dkg2}
   */
  part2(secret, broadcasts) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      _assertClass(broadcasts, MessageSet)
      wasm.dkg_part2(retptr, this.__wbg_ptr, ptr0, len0, broadcasts.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return Dkg2.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Round 3: finalize with the broadcasts and the packages addressed to this device.
   * @param {Uint8Array} secret
   * @param {MessageSet} broadcasts
   * @param {MessageSet} incoming
   * @returns {Dkg3}
   */
  part3(secret, broadcasts, incoming) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      _assertClass(broadcasts, MessageSet)
      _assertClass(incoming, MessageSet)
      wasm.dkg_part3(retptr, this.__wbg_ptr, ptr0, len0, broadcasts.__wbg_ptr, incoming.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return Dkg3.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {number}
   */
  slot() {
    const ret = wasm.dkg_slot(this.__wbg_ptr)
    return ret
  }
  /**
   * The static public key carried inside a round-1 broadcast.
   *
   * A coordinator that handles one device at a time has each broadcast as bytes and needs the
   * sender's key in order to seal KEYSET_SETUP to it. Use this rather than taking the framing apart.
   * @param {Uint8Array} broadcast
   * @returns {Uint8Array}
   */
  static static_public_of_broadcast(broadcast) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(broadcast, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.dkg_static_public_of_broadcast(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Dkg.prototype[Symbol.dispose] = Dkg.prototype.free

/**
 * Round 1 of a distributed key generation: a secret to keep, a broadcast to send.
 */
export class Dkg1 {
  static __wrap(ptr) {
    const obj = Object.create(Dkg1.prototype)
    obj.__wbg_ptr = ptr
    Dkg1Finalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    Dkg1Finalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_dkg1_free(ptr, 0)
  }
  /**
   * Public broadcast for every other participant.
   * @returns {Uint8Array}
   */
  broadcast() {
    const ret = wasm.dkg1_broadcast(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * The broadcast wrapped in a `DKGR1` envelope addressed to the coordinator.
   *
   * Use this instead of shipping the raw bytes: the envelope is what binds the payload to this
   * session, this sender and this round, and what lets the relay reject replays.
   * @param {Uint8Array} session_id
   * @param {number} sequence
   * @param {number} my_slot
   * @returns {Uint8Array}
   */
  broadcast_envelope(session_id, sequence, my_slot) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.dkg1_broadcast_envelope(retptr, this.__wbg_ptr, ptr0, len0, sequence, my_slot)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Secret state for round 2. Persist it under the device keystore; it never leaves the device.
   * @returns {Uint8Array}
   */
  secret() {
    const ret = wasm.dkg1_secret(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * This device's static public key. Publish it; peers seal later ceremony messages to it.
   * @returns {Uint8Array}
   */
  static_public() {
    const ret = wasm.dkg1_static_public(this.__wbg_ptr)
    return takeObject(ret)
  }
}
if (Symbol.dispose) Dkg1.prototype[Symbol.dispose] = Dkg1.prototype.free

/**
 * Round 2 output: a secret to keep plus one sealed package per peer.
 */
export class Dkg2 {
  static __wrap(ptr) {
    const obj = Object.create(Dkg2.prototype)
    obj.__wbg_ptr = ptr
    Dkg2Finalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    Dkg2Finalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_dkg2_free(ptr, 0)
  }
  /**
   * Packages to deliver, indexed by recipient slot.
   * @returns {MessageSet}
   */
  outgoing() {
    const ret = wasm.dkg2_outgoing(this.__wbg_ptr)
    return MessageSet.__wrap(ret)
  }
  /**
   * The whole batch wrapped in a `DKGR2BATCH` envelope addressed to the coordinator.
   * @param {Uint8Array} session_id
   * @param {number} sequence
   * @param {number} my_slot
   * @returns {Uint8Array}
   */
  outgoing_envelope(session_id, sequence, my_slot) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.dkg2_outgoing_envelope(retptr, this.__wbg_ptr, ptr0, len0, sequence, my_slot)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {Uint8Array}
   */
  secret() {
    const ret = wasm.dkg2_secret(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * Every participant's static public key, by slot, including this device's — learned from the
   * round-1 broadcasts. This is what KEYSET_SETUP seals to; there is no need to parse the broadcast
   * framing to get it.
   * @returns {MessageSet}
   */
  statics() {
    const ret = wasm.dkg2_statics(this.__wbg_ptr)
    return MessageSet.__wrap(ret)
  }
}
if (Symbol.dispose) Dkg2.prototype[Symbol.dispose] = Dkg2.prototype.free

/**
 * Round 3 output: this device's key package and the group's public package.
 */
export class Dkg3 {
  static __wrap(ptr) {
    const obj = Object.create(Dkg3.prototype)
    obj.__wbg_ptr = ptr
    Dkg3Finalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    Dkg3Finalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_dkg3_free(ptr, 0)
  }
  /**
   * `ak`, the group's spend validating key. Every other call needs it: the keyset derivation, the
   * share backup binding and the signature verification all take it.
   * @returns {Uint8Array}
   */
  group_verifying_key() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.dkg3_group_verifying_key(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The share. Persist it as a [`ShareBackup`]; never transmit it.
   * @returns {Uint8Array}
   */
  key_package() {
    const ret = wasm.dkg3_key_package(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * The public group state. Safe to share; every device must end up with the same bytes.
   * @returns {Uint8Array}
   */
  public_key_package() {
    const ret = wasm.dkg3_public_key_package(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * This ceremony's static public key. Publish it (it already travels in the round-1 broadcast).
   * @returns {Uint8Array}
   */
  static_public() {
    const ret = wasm.dkg3_static_public(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * The matching static secret, for sealing later ceremony messages (KEYSET_SETUP) to peers.
   *
   * Keep it on the device. It cannot spend; it only lets peers send this device a message nobody
   * else can read.
   * @returns {Uint8Array}
   */
  static_secret() {
    const ret = wasm.dkg3_static_secret(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * Every participant's static public key, by slot, including this device's own.
   * @returns {MessageSet}
   */
  statics() {
    const ret = wasm.dkg3_statics(this.__wbg_ptr)
    return MessageSet.__wrap(ret)
  }
}
if (Symbol.dispose) Dkg3.prototype[Symbol.dispose] = Dkg3.prototype.free

/**
 * The coordinator's side of the DKG message flow.
 *
 * Signers send `DKGR1` / `DKGR2BATCH` envelopes; the coordinator validates who sent them and in what
 * order, then forwards a `DKGR1BUNDLE` / `DKGR2INBOX` to each peer. This type exists so that the
 * session binding, roster check and replay rejection are not left to the app to reimplement.
 *
 * Round-2 packages are sealed to their recipient inside the DKG implementation (Noise, single
 * message, ceremony as prologue), so a relay can forward them but cannot read them.
 */
export class DkgRelay {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    DkgRelayFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_dkgrelay_free(ptr, 0)
  }
  /**
   * Validate an envelope from a signer and return `[senderSlot, payload]`.
   *
   * `expected` is the message type name (`"dkgR1"` or `"dkgR2Batch"`). Anything that is not from a
   * roster slot, not addressed to the coordinator, not the expected type, or not newer than the
   * last message from that sender is refused.
   * @param {Uint8Array} envelope
   * @param {string} expected
   * @returns {Array<any>}
   */
  accept(envelope, expected) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passStringToWasm0(expected, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      wasm.dkgrelay_accept(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Forward a bundle to one recipient: `DKGR1BUNDLE` in round 1, `DKGR2INBOX` in round 2.
   * @param {number} round
   * @param {number} recipient
   * @param {MessageSet} messages
   * @returns {Uint8Array}
   */
  bundle(round, recipient, messages) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      _assertClass(messages, MessageSet)
      wasm.dkgrelay_bundle(retptr, this.__wbg_ptr, round, recipient, messages.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {Uint8Array} session_id
   * @param {number} participants
   */
  constructor(session_id, participants) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.dkgrelay_new(retptr, ptr0, len0, participants)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      DkgRelayFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) DkgRelay.prototype[Symbol.dispose] = DkgRelay.prototype.free

/**
 * Encode/decode an envelope. The frontend may treat envelopes as opaque bytes, but exposing the codec
 * lets it validate framing before spending a QR frame on it.
 */
export class EnvelopeCodec {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    EnvelopeCodecFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_envelopecodec_free(ptr, 0)
  }
  /**
   * Build a `SIGN_INIT`-shaped envelope. Mostly useful for transport tests.
   * @param {number} msg_type
   * @param {number} round
   * @param {number} sender
   * @param {number} recipient
   * @param {number} sequence
   * @param {Uint8Array} session_id
   * @param {Uint8Array} payload
   * @returns {Uint8Array}
   */
  static build(msg_type, round, sender, recipient, sequence, session_id, payload) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(payload, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.envelopecodec_build(
        retptr,
        msg_type,
        round,
        sender,
        recipient,
        sequence,
        ptr0,
        len0,
        ptr1,
        len1
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Build a `SIGN_REJECT` envelope. `code`: 1 user declined, 2 verification failed, 3 malformed, 4 expired.
   * @param {Uint8Array} session_id
   * @param {number} sender
   * @param {number} recipient
   * @param {number} sequence
   * @param {number} code
   * @param {string} note
   * @returns {Uint8Array}
   */
  static buildSignReject(session_id, sender, recipient, sequence, code, note) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passStringToWasm0(note, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      wasm.envelopecodec_buildSignReject(
        retptr,
        ptr0,
        len0,
        sender,
        recipient,
        sequence,
        code,
        ptr1,
        len1
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Build a `SIGN_RESULT` envelope. `status`: 0 broadcasted (txid required), 1 failed (no txid).
   * @param {Uint8Array} session_id
   * @param {number} sender
   * @param {number} recipient
   * @param {number} sequence
   * @param {number} status
   * @param {Uint8Array | null | undefined} txid
   * @param {string} note
   * @returns {Uint8Array}
   */
  static buildSignResult(session_id, sender, recipient, sequence, status, txid, note) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      var ptr1 = isLikeNone(txid) ? 0 : passArray8ToWasm0(txid, wasm.__wbindgen_export)
      var len1 = WASM_VECTOR_LEN
      const ptr2 = passStringToWasm0(note, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len2 = WASM_VECTOR_LEN
      wasm.envelopecodec_buildSignResult(
        retptr,
        ptr0,
        len0,
        sender,
        recipient,
        sequence,
        status,
        ptr1,
        len1,
        ptr2,
        len2
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Build a signing-session envelope; the round comes from the message type.
   *
   * Use this instead of `build` for signing messages: `build` takes the round as an argument, which is
   * how a caller ends up sending a round the receiver refuses.
   * @param {number} msg_type
   * @param {number} sender
   * @param {number} recipient
   * @param {number} sequence
   * @param {Uint8Array} session_id
   * @param {Uint8Array} payload
   * @returns {Uint8Array}
   */
  static buildSigning(msg_type, sender, recipient, sequence, session_id, payload) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(payload, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.envelopecodec_buildSigning(
        retptr,
        msg_type,
        sender,
        recipient,
        sequence,
        ptr0,
        len0,
        ptr1,
        len1
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The slot reserved for the coordinator, which may hold no share.
   * @returns {number}
   */
  static get coordinator_slot() {
    const ret = wasm.envelopecodec_coordinator_slot()
    return ret
  }
  /**
   * Decode an envelope into a JSON-ish object: `{ msgType, round, sender, recipient, sequence,
   * sessionId: Uint8Array, payload: Uint8Array }` as a JS array, to keep the surface primitive.
   * @param {Uint8Array} bytes
   * @returns {Array<any>}
   */
  static decode(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_decode(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The type names that have a defined payload.
   * @returns {Array<any>}
   */
  static defined_msg_types() {
    const ret = wasm.envelopecodec_defined_msg_types()
    return takeObject(ret)
  }
  /**
   * Wire value of a message type **whose payload this crate defines**.
   *
   * Eight types qualify today: the four signing messages, whose payloads the session produces, and
   * the four DKG messages, whose payloads are this crate's own DKG bytes and packed batches.
   *
   * The protocol table also reserves numbers for messages that have no payload format yet —
   * `PAIR_INVITE`, `ROSTER_LOCK`, `KEYSET_SETUP` and others. Those are deliberately refused here so
   * that an undefined type cannot become a de-facto contract by accident; use
   * [`Self::reserved_msg_type`] if you genuinely need the number, and know that nothing defines
   * what goes in it.
   * @param {string} name
   * @returns {number}
   */
  static msg_type(name) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_msg_type(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return r0
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * A fresh 16-byte session id, from this module's OS-backed entropy.
   *
   * Use this rather than a counter or a timestamp: a repeated id would make a stale session
   * marker look like the current session after a restart, which is exactly the case the marker
   * exists to catch.
   * @returns {Uint8Array}
   */
  static new_session_id() {
    const ret = wasm.envelopecodec_new_session_id()
    return takeObject(ret)
  }
  /**
   * Decode a `SIGN_REJECT` envelope into `[sender, sequence, sessionId, code, note]`.
   * @param {Uint8Array} bytes
   * @returns {Array<any>}
   */
  static readSignReject(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_readSignReject(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Decode a `SIGN_RESULT` envelope into `[sender, sequence, sessionId, status, txid|null, note]`.
   * @param {Uint8Array} bytes
   * @returns {Array<any>}
   */
  static readSignResult(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_readSignResult(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Read a signing-session envelope, refusing a type outside the signing set and a round that disagrees
   * with its type. Returns the same shape as `decode`.
   * @param {Uint8Array} bytes
   * @returns {Array<any>}
   */
  static readSigning(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_readSigning(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Wire value of a reject code, by the name the phone uses.
   * @param {string} name
   * @returns {number}
   */
  static rejectCode(name) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_rejectCode(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return r0
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Wire value of a **reserved** type: the number exists in the protocol table, but no payload
   * format is defined for it. Prefer [`Self::msg_type`]; this exists so a caller can decode a
   * message it received rather than invent one it should not send.
   * @param {string} name
   * @returns {number}
   */
  static reserved_msg_type(name) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_reserved_msg_type(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return r0
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The type names that are reserved without a payload format.
   * @returns {Array<any>}
   */
  static reserved_msg_types() {
    const ret = wasm.envelopecodec_reserved_msg_types()
    return takeObject(ret)
  }
  /**
   * The `round` a message type belongs to, per the spec's message table.
   *
   * The value is enforced only inside a session: `readSigning` and the signing sessions refuse an
   * envelope whose round disagrees with its type. Nothing checks the DKG rounds, so this is a lookup
   * for callers that fill the field themselves — a wrong value produces a message the peer refuses,
   * not a local error.
   * @param {string} name
   * @returns {number}
   */
  static round_of(name) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.envelopecodec_round_of(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return r0
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) EnvelopeCodec.prototype[Symbol.dispose] = EnvelopeCodec.prototype.free

export class IntoUnderlyingByteSource {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    IntoUnderlyingByteSourceFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_intounderlyingbytesource_free(ptr, 0)
  }
  /**
   * @returns {number}
   */
  get autoAllocateChunkSize() {
    const ret = wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr)
    return ret >>> 0
  }
  cancel() {
    const ptr = this.__destroy_into_raw()
    wasm.intounderlyingbytesource_cancel(ptr)
  }
  /**
   * @param {ReadableByteStreamController} controller
   * @returns {Promise<any>}
   */
  pull(controller) {
    const ret = wasm.intounderlyingbytesource_pull(this.__wbg_ptr, addHeapObject(controller))
    return takeObject(ret)
  }
  /**
   * @param {ReadableByteStreamController} controller
   */
  start(controller) {
    wasm.intounderlyingbytesource_start(this.__wbg_ptr, addHeapObject(controller))
  }
  /**
   * @returns {ReadableStreamType}
   */
  get type() {
    const ret = wasm.intounderlyingbytesource_type(this.__wbg_ptr)
    return __wbindgen_enum_ReadableStreamType[ret]
  }
}
if (Symbol.dispose)
  IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free

export class IntoUnderlyingSink {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    IntoUnderlyingSinkFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_intounderlyingsink_free(ptr, 0)
  }
  /**
   * @param {any} reason
   * @returns {Promise<any>}
   */
  abort(reason) {
    const ptr = this.__destroy_into_raw()
    const ret = wasm.intounderlyingsink_abort(ptr, addHeapObject(reason))
    return takeObject(ret)
  }
  /**
   * @returns {Promise<any>}
   */
  close() {
    const ptr = this.__destroy_into_raw()
    const ret = wasm.intounderlyingsink_close(ptr)
    return takeObject(ret)
  }
  /**
   * @param {any} chunk
   * @returns {Promise<any>}
   */
  write(chunk) {
    const ret = wasm.intounderlyingsink_write(this.__wbg_ptr, addHeapObject(chunk))
    return takeObject(ret)
  }
}
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free

export class IntoUnderlyingSource {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    IntoUnderlyingSourceFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_intounderlyingsource_free(ptr, 0)
  }
  cancel() {
    const ptr = this.__destroy_into_raw()
    wasm.intounderlyingsource_cancel(ptr)
  }
  /**
   * @param {ReadableStreamDefaultController} controller
   * @returns {Promise<any>}
   */
  pull(controller) {
    const ret = wasm.intounderlyingsource_pull(this.__wbg_ptr, addHeapObject(controller))
    return takeObject(ret)
  }
}
if (Symbol.dispose)
  IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free

/**
 * Keyset setup: `ak` plus the recovery key to a receiving address.
 */
export class Keyset {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    KeysetFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_keyset_free(ptr, 0)
  }
  /**
   * Whether the derived address carries only an Orchard receiver. Must always be true; the
   * frontend should refuse to show an address where it is not.
   * @param {string} address
   * @returns {boolean}
   */
  static address_is_shielded_only(address) {
    const ptr0 = passStringToWasm0(address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.keyset_address_is_shielded_only(ptr0, len0)
    return ret !== 0
  }
  /**
   * Returns `[fvk(96), ufvk, address, rawAddress(43), fingerprint(32)]`.
   * @param {Uint8Array} group_verifying_key
   * @param {Uint8Array} qsk
   * @param {boolean} mainnet
   * @param {number} diversifier_index
   * @returns {Array<any>}
   */
  static derive(group_verifying_key, qsk, mainnet, diversifier_index) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(qsk, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.keyset_derive(retptr, ptr0, len0, ptr1, len1, mainnet, diversifier_index)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The keyset fingerprint, recomputed from an FVK: `SHA-256(domain ‖ network_tag ‖ fvk)`.
   *
   * Recovery needs this: a device keeps the FVK but not the `qsk`, so [`Self::derive`] is not
   * available to it, and the fingerprint is what the user compares against an independent device to
   * detect a coordinator handing over a viewing key with a real `ak` and attacker-chosen
   * `nk`/`rivk`.
   *
   * Do not reimplement this hash elsewhere: the domain tag and network tag are part of the preimage,
   * and a one-byte difference makes two implementations disagree forever.
   * @param {Uint8Array} fvk
   * @param {boolean} mainnet
   * @returns {Uint8Array}
   */
  static fingerprint_from_fvk(fvk, mainnet) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(fvk, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.keyset_fingerprint_from_fvk(retptr, ptr0, len0, mainnet)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * `fingerprint_from_fvk` for callers holding the encoded UFVK.
   * @param {string} ufvk
   * @param {boolean} mainnet
   * @returns {Uint8Array}
   */
  static fingerprint_from_ufvk(ufvk, mainnet) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(ufvk, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.keyset_fingerprint_from_ufvk(retptr, ptr0, len0, mainnet)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The 96-byte FVK inside a UFVK string.
   *
   * A recovering device receives a viewing key but not the `qsk` behind it, so it cannot re-derive
   * anything with [`Self::derive`]. This reads the key back out.
   * @param {string} ufvk
   * @returns {Uint8Array}
   */
  static fvk_from_ufvk(ufvk) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(ufvk, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.keyset_fvk_from_ufvk(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * A fresh `qsk`: the `nk`/`rivk` source, and the ZIP-2005 recovery candidate.
   *
   * Generate it **once**, on one device, then deliver it to every other device over a
   * confidential, authenticated channel — the same one the DKG round-2 packages need. Every
   * device must pass the identical `qsk` to [`Self::derive`] or they will land on different
   * addresses for the same group.
   *
   * It cannot spend: spend authorization is `ak`, which lives only in the FROST shares. Holding
   * `qsk` does not weaken the threshold, which is why backing it up is cheap insurance.
   * @returns {Uint8Array}
   */
  static generate_qsk() {
    const ret = wasm.keyset_generate_qsk()
    return takeObject(ret)
  }
  /**
   * Whether a UFVK was derived from this group key.
   *
   * Run this before trusting a viewing key handed to you by a coordinator or a peer: `ak` is the
   * first 32 bytes of the FVK, and a mismatch would restore the device into a different, empty
   * wallet.
   * @param {string} ufvk
   * @param {Uint8Array} group_verifying_key
   * @returns {boolean}
   */
  static ufvk_matches_ak(ufvk, group_verifying_key) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(ufvk, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.keyset_ufvk_matches_ak(retptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return r0 !== 0
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Keyset.prototype[Symbol.dispose] = Keyset.prototype.free

/**
 * A set of messages indexed by peer slot.
 *
 * The frontend fills this with whatever its transport received, and reads it back after a round.
 * Exists so the wire format of a message batch stays inside the wasm.
 */
export class MessageSet {
  static __wrap(ptr) {
    const obj = Object.create(MessageSet.prototype)
    obj.__wbg_ptr = ptr
    MessageSetFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    MessageSetFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_messageset_free(ptr, 0)
  }
  /**
   * Unpack an envelope payload back into a set.
   * @param {Uint8Array} bytes
   * @returns {MessageSet}
   */
  static from_bytes(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.messageset_from_bytes(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return MessageSet.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {number} slot
   * @returns {Uint8Array | undefined}
   */
  get(slot) {
    const ret = wasm.messageset_get(this.__wbg_ptr, slot)
    return takeObject(ret)
  }
  /**
   * @returns {boolean}
   */
  is_empty() {
    const ret = wasm.messageset_is_empty(this.__wbg_ptr)
    return ret !== 0
  }
  /**
   * @returns {number}
   */
  len() {
    const ret = wasm.messageset_len(this.__wbg_ptr)
    return ret >>> 0
  }
  constructor() {
    const ret = wasm.messageset_new()
    this.__wbg_ptr = ret
    MessageSetFinalization.register(this, this.__wbg_ptr, this)
    return this
  }
  /**
   * Add or replace the payload for a peer.
   * @param {number} slot
   * @param {Uint8Array} bytes
   */
  set(slot, bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
    const len0 = WASM_VECTOR_LEN
    wasm.messageset_set(this.__wbg_ptr, slot, ptr0, len0)
  }
  /**
   * @returns {Uint8Array}
   */
  slots() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.messageset_slots(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var v1 = getArrayU8FromWasm0(r0, r1).slice()
      wasm.__wbindgen_export4(r0, r1 * 1, 1)
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Pack for transport as one envelope payload.
   * @returns {Uint8Array}
   */
  to_bytes() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.messageset_to_bytes(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) MessageSet.prototype[Symbol.dispose] = MessageSet.prototype.free

/**
 * The Noise XX channel used under BLE.
 *
 * WebCrypto has no BLAKE2s, so this cannot be written in the extension: a hand-rolled Noise state
 * machine in JavaScript would be a third implementation of a security-critical protocol. GATT reads and
 * writes stay in the host — this only turns plaintext into bytes and back.
 *
 * XX is three messages: initiator writes, responder replies, initiator finishes. After that both sides
 * can `encrypt`/`decrypt`.
 *
 * **Message 1's payload is plaintext.** Noise has no key before the first DH, so nothing that matters may
 * be carried there; the initiator's static key is only revealed and proved in message 3. Use message 1
 * for nothing, or for data you would be happy to see forged.
 */
export class NoiseXx {
  static __wrap(ptr) {
    const obj = Object.create(NoiseXx.prototype)
    obj.__wbg_ptr = ptr
    NoiseXxFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    NoiseXxFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_noisexx_free(ptr, 0)
  }
  /**
   * Decrypt one payload from the peer.
   * @param {Uint8Array} ciphertext
   * @returns {Uint8Array}
   */
  decrypt(ciphertext) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.noisexx_decrypt(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Encrypt one payload. Completes the handshake first if it is finished but not yet converted.
   * @param {Uint8Array} plaintext
   * @returns {Uint8Array}
   */
  encrypt(plaintext) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.noisexx_encrypt(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The handshake hash. Both ends must agree; unavailable until the handshake completes.
   * @returns {Uint8Array}
   */
  handshake_hash() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.noisexx_handshake_hash(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Start the channel as the connecting side.
   * @param {Uint8Array} static_private
   * @param {Uint8Array} prologue
   * @returns {NoiseXx}
   */
  static initiator(static_private, prologue) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(static_private, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(prologue, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.noisexx_initiator(retptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return NoiseXx.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {boolean}
   */
  is_handshake_finished() {
    const ret = wasm.noisexx_is_handshake_finished(this.__wbg_ptr)
    return ret !== 0
  }
  /**
   * Whether the channel is dead after an authentication failure.
   *
   * Noise advances the nonce before verifying the tag, so one bad message leaves the two sides out of
   * step permanently. When this is true the host must drop the channel and handshake again — every
   * later call returns an error.
   * @returns {boolean}
   */
  is_poisoned() {
    const ret = wasm.noisexx_is_poisoned(this.__wbg_ptr)
    return ret !== 0
  }
  /**
   * Read a handshake message from the peer, returning its payload.
   * @param {Uint8Array} message
   * @returns {Uint8Array}
   */
  read_handshake(message) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.noisexx_read_handshake(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Rotate the sending and receiving keys, as Noise's `rekey` specifies.
   */
  rekey() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.noisexx_rekey(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The peer's static public key, once the handshake has revealed it.
   * @returns {Uint8Array | undefined}
   */
  remote_static() {
    const ret = wasm.noisexx_remote_static(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * Start the channel as the accepting side.
   * @param {Uint8Array} static_private
   * @param {Uint8Array} prologue
   * @returns {NoiseXx}
   */
  static responder(static_private, prologue) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(static_private, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(prologue, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.noisexx_responder(retptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return NoiseXx.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The X25519 public key belonging to a static private key.
   * @param {Uint8Array} private_key
   * @returns {Uint8Array}
   */
  static static_public_from(private_key) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(private_key, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.noisexx_static_public_from(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Write the next handshake message for this side.
   * @param {Uint8Array} payload
   * @returns {Uint8Array}
   */
  write_handshake(payload) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(payload, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.noisexx_write_handshake(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) NoiseXx.prototype[Symbol.dispose] = NoiseXx.prototype.free

export class PaymentRequest {
  static __wrap(ptr) {
    const obj = Object.create(PaymentRequest.prototype)
    obj.__wbg_ptr = ptr
    PaymentRequestFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  static __unwrap(jsValue) {
    if (!(jsValue instanceof PaymentRequest)) {
      return 0
    }
    return jsValue.__destroy_into_raw()
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    PaymentRequestFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_paymentrequest_free(ptr, 0)
  }
  /**
   * @returns {bigint}
   */
  amount() {
    const ret = wasm.paymentrequest_amount(this.__wbg_ptr)
    return BigInt.asUintN(64, ret)
  }
  /**
   * @returns {string | undefined}
   */
  label() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.paymentrequest_label(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      let v1
      if (r0 !== 0) {
        v1 = getStringFromWasm0(r0, r1).slice()
        wasm.__wbindgen_export4(r0, r1 * 1, 1)
      }
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {Uint8Array | undefined}
   */
  memo() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.paymentrequest_memo(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      let v1
      if (r0 !== 0) {
        v1 = getArrayU8FromWasm0(r0, r1).slice()
        wasm.__wbindgen_export4(r0, r1 * 1, 1)
      }
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {string | undefined}
   */
  message() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.paymentrequest_message(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      let v1
      if (r0 !== 0) {
        v1 = getStringFromWasm0(r0, r1).slice()
        wasm.__wbindgen_export4(r0, r1 * 1, 1)
      }
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {string} recipient_address
   * @param {bigint} amount
   * @param {Uint8Array | null | undefined} memo
   * @param {string | null | undefined} label
   * @param {string | null | undefined} message
   * @param {any} other_params
   */
  constructor(recipient_address, amount, memo, label, message, other_params) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(
        recipient_address,
        wasm.__wbindgen_export,
        wasm.__wbindgen_export2
      )
      const len0 = WASM_VECTOR_LEN
      var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
      var len1 = WASM_VECTOR_LEN
      var ptr2 = isLikeNone(label)
        ? 0
        : passStringToWasm0(label, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      var len2 = WASM_VECTOR_LEN
      var ptr3 = isLikeNone(message)
        ? 0
        : passStringToWasm0(message, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      var len3 = WASM_VECTOR_LEN
      wasm.paymentrequest_new(
        retptr,
        ptr0,
        len0,
        amount,
        ptr1,
        len1,
        ptr2,
        len2,
        ptr3,
        len3,
        addHeapObject(other_params)
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      PaymentRequestFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {any}
   */
  other_params() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.paymentrequest_other_params(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {string}
   */
  recipient_address() {
    let deferred1_0
    let deferred1_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.paymentrequest_recipient_address(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      deferred1_0 = r0
      deferred1_1 = r1
      return getStringFromWasm0(r0, r1)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1)
    }
  }
  /**
   * @param {string} recipient_address
   * @param {bigint} amount
   * @returns {PaymentRequest}
   */
  static simple_payment(recipient_address, amount) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(
        recipient_address,
        wasm.__wbindgen_export,
        wasm.__wbindgen_export2
      )
      const len0 = WASM_VECTOR_LEN
      wasm.paymentrequest_simple_payment(retptr, ptr0, len0, amount)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return PaymentRequest.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) PaymentRequest.prototype[Symbol.dispose] = PaymentRequest.prototype.free

export class Pczt {
  static __wrap(ptr) {
    const obj = Object.create(Pczt.prototype)
    obj.__wbg_ptr = ptr
    PcztFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    PcztFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_pczt_free(ptr, 0)
  }
  /**
   * Verifies and applies signatures returned by Ledger's PCZT signer.
   * @param {any} value
   * @param {number} account_index
   * @returns {Pczt}
   */
  apply_ledger_signatures(value, account_index) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.pczt_apply_ledger_signatures(retptr, this.__wbg_ptr, addHeapObject(value), account_index)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return Pczt.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Combines this PCZT with another representing the same transaction.
   *
   * Used after external signing: `self` is the full PCZT kept by the wallet
   * (with witnesses) and `other` is the redacted PCZT returned by the signer
   * (with signatures). The result carries both, ready for proving and
   * extraction.
   * @param {Pczt} other
   * @returns {Pczt}
   */
  combine(other) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      _assertClass(other, Pczt)
      wasm.pczt_combine(retptr, this.__wbg_ptr, other.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return Pczt.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Deserialize to a Pczt from postcard bytes.
   * @param {Uint8Array} bytes
   * @returns {Pczt}
   */
  static from_bytes(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.pczt_from_bytes(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return Pczt.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Returns a Pczt from a JSON object
   * @param {any} s
   * @returns {Pczt}
   */
  static from_json(s) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.pczt_from_json(retptr, addHeapObject(s))
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return Pczt.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Strips prover-only data so the PCZT is small enough to transport to an
   * external signer (e.g. Keystone) as an animated QR.
   *
   * Mirrors the "redact for signer" role used by Zashi: removes spend
   * witnesses (the per-note Merkle authentication paths that dominate the
   * serialized size) and the `zcash_client_backend` proprietary metadata.
   * The signer only needs the spend randomizers, values and derivation
   * paths, so the redacted PCZT still produces valid signatures. The
   * original (full) PCZT must be retained and merged back with [`combine`]
   * after signing to restore the witnesses required for proving.
   *
   * [`combine`]: Pczt::combine
   * @returns {Pczt}
   */
  redact_for_signer() {
    const ret = wasm.pczt_redact_for_signer(this.__wbg_ptr)
    return Pczt.__wrap(ret)
  }
  /**
   * Returns the postcard serialization of the Pczt.
   * @returns {Uint8Array}
   */
  serialize() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.pczt_serialize(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      if (r3) {
        throw takeObject(r2)
      }
      var v1 = getArrayU8FromWasm0(r0, r1).slice()
      wasm.__wbindgen_export4(r0, r1 * 1, 1)
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Returns a JSON object with the details of the Pczt.
   * @returns {any}
   */
  to_json() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.pczt_to_json(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Produces the structured transaction consumed by Ledger's Zcash signer.
   * The returned action-index arrays are retained by the wallet and bind the
   * device's compact signature result back to the original PCZT actions.
   * @param {number} account_index
   * @returns {any}
   */
  to_ledger_signing_payload(account_index) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.pczt_to_ledger_signing_payload(retptr, this.__wbg_ptr, account_index)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Pczt.prototype[Symbol.dispose] = Pczt.prototype.free

/**
 * PCZT handling the frontend needs around a signing session: shrink the request, read what to sign,
 * put the signatures back.
 *
 * Deliberately no proving: building and proving belongs to the wallet's own transaction path, and
 * linking Halo2 here would double the module size for something already present.
 */
export class PcztTools {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    PcztToolsFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_pczttools_free(ptr, 0)
  }
  /**
   * Every Ironwood action's `alpha`, 32 bytes each, in action order. This is what the coordinator
   * hands to the signers, and what `Verification::rk` needs.
   * @param {Uint8Array} bytes
   * @returns {Uint8Array}
   */
  static action_alphas(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.pczttools_action_alphas(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Every Ironwood action's `rk`, 32 bytes each, in action order.
   * @param {Uint8Array} bytes
   * @returns {Uint8Array}
   */
  static action_rks(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.pczttools_action_rks(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Write signatures back. `signatures` is 64 bytes per action, positionally matching `indices`.
   * @param {Uint8Array} bytes
   * @param {Uint8Array} indices
   * @param {Uint8Array} signatures
   * @returns {Uint8Array}
   */
  static apply_signatures(bytes, indices, signatures) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(indices, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(signatures, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      wasm.pczttools_apply_signatures(retptr, ptr0, len0, ptr1, len1, ptr2, len2)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Fail unless this transaction is one the vault is allowed to sign (V6, Ironwood only, no
   * transparent or Sapling part).
   * @param {Uint8Array} bytes
   */
  static check(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.pczttools_check(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Whether every action's `rk` equals `ak + alpha·G`. Run this on the signer before approving.
   * @param {Uint8Array} bytes
   * @param {Uint8Array} group_verifying_key
   * @param {Uint8Array} alphas
   */
  static check_action_bindings(bytes, group_verifying_key, alphas) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(alphas, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      wasm.pczttools_check_action_bindings(retptr, ptr0, len0, ptr1, len1, ptr2, len2)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The signer's own reading of the transaction: every output (recipient, amount, change, memo) and
   * every spend, with the totals and the fee.
   *
   * Returns `[reviewedPcztSha256, outputs, spends, sentTotal, changeTotal, fee, header]` where:
   *
   * * `reviewedPcztSha256` — SHA-256 of **the bytes passed in**, so a caller can persist "this is the
   *   transaction I reviewed" and compare it later. Compute it on the PCZT the user was shown, not on a
   *   later, proved copy: proving changes the bytes.
   * * `outputs` — array of `[recipient(43), value, isChange, memoOrNull]`. `memoOrNull` is either the
   *   exact 512-byte memo (ZIP-302 marker and padding included) or `null` for "could not verify"; the
   *   two must never be conflated, so a caller that needs a memo must reject `null`.
   * * `spends` — array of `[actionIndex, nullifier(32), value]`, one per spend that belongs to this
   *   viewing key. The first element is the position **inside the bundle**, which is what signature
   *   write-back needs; filler actions shift it, so it is not the position in this array.
   * * `sentTotal` / `changeTotal` / `fee` — in zats, as JS `Number`s. ZEC has 8 decimals, so every valid
   *   amount (≤ 21e6 ZEC = 2.1e15 zats) is well inside `Number.MAX_SAFE_INTEGER`; callers should still
   *   reject anything above that rather than trust the conversion.
   * * `header` — `{ txVersion, versionGroupId, consensusBranchId, expiryHeight, coinType }`, read from the
   *   PCZT's global section. `coinType` is the builder's claim (0 mainnet, 1 testnet), not a proof of
   *   network; compare it with the wallet's configuration.
   *
   * Fails wholesale if any check fails: there is no "partially reviewed" result to approve.
   * @param {Uint8Array} bytes
   * @param {Uint8Array} fvk
   * @returns {Array<any>}
   */
  static review(bytes, fvk) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(fvk, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.pczttools_review(retptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The shielded sighash, recomputed from the PCZT. Signers must use this value, never one handed
   * to them by the coordinator.
   * @param {Uint8Array} bytes
   * @returns {Uint8Array}
   */
  static shielded_sighash(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.pczttools_shielded_sighash(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The action indices this signer must produce signatures for, in bundle order.
   *
   * A bundle has one spend and one output per action, so a transaction that pays two addresses carries a
   * zero-value filler spend that belongs to nobody. Those actions must be excluded from signing — their
   * `rk` is not the group key — while their original `action_index` values are what signature write-back
   * needs. Signing the position in this array instead of the index is the bug this returns indices to
   * prevent.
   *
   * Fails if an action is neither ours nor a valid filler: a non-zero spend whose `rk` is not
   * `ak + alpha·G`, or a zero-value one that arrives unsigned.
   * @param {Uint8Array} bytes
   * @param {Uint8Array} group_verifying_key
   * @returns {Uint8Array}
   */
  static signingSet(bytes, group_verifying_key) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.pczttools_signingSet(retptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Drop the zk proof: the transport copy. The coordinator keeps its own proven copy for applying
   * signatures.
   * @param {Uint8Array} bytes
   * @returns {Uint8Array}
   */
  static strip_proofs(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.pczttools_strip_proofs(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) PcztTools.prototype[Symbol.dispose] = PcztTools.prototype.free

export class ProofGenerationKey {
  static __wrap(ptr) {
    const obj = Object.create(ProofGenerationKey.prototype)
    obj.__wbg_ptr = ptr
    ProofGenerationKeyFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    ProofGenerationKeyFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_proofgenerationkey_free(ptr, 0)
  }
}
if (Symbol.dispose) ProofGenerationKey.prototype[Symbol.dispose] = ProofGenerationKey.prototype.free

export class Proposal {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    ProposalFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_proposal_free(ptr, 0)
  }
}
if (Symbol.dispose) Proposal.prototype[Symbol.dispose] = Proposal.prototype.free

/**
 * The roster hash, computed here so no other language keeps its own copy of the encoding.
 *
 * The wire format is fixed by agreement with the mobile client; the domain tag is concatenated raw,
 * every field carries a 4-byte big-endian length, and numbers are canonical decimal text. A different
 * encoding produces a different hash, and two devices that disagree on the roster hash will refuse to
 * proceed — which is the point, but makes a silent drift expensive to debug.
 */
export class RosterManifest {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    RosterManifestFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_rostermanifest_free(ptr, 0)
  }
  /**
   * Add a participant. Call order does not matter: the encoding sorts by slot.
   * @param {number} slot
   * @param {Uint8Array} identity_public_key
   * @param {Uint8Array} transport_public_key
   */
  add_participant(slot, identity_public_key, transport_public_key) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(identity_public_key, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(transport_public_key, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.rostermanifest_add_participant(retptr, this.__wbg_ptr, slot, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The exact bytes that are hashed. For test vectors and debugging.
   * @returns {Uint8Array}
   */
  canonical_bytes() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.rostermanifest_canonical_bytes(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * `SHA-256(canonical_bytes)`.
   * @returns {Uint8Array}
   */
  hash() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.rostermanifest_hash(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Lowercase hex of the hash, for comparing against the agreed vectors.
   * @returns {string}
   */
  hash_hex() {
    let deferred2_0
    let deferred2_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.rostermanifest_hash_hex(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      var ptr1 = r0
      var len1 = r1
      if (r3) {
        ptr1 = 0
        len1 = 0
        throw takeObject(r2)
      }
      deferred2_0 = ptr1
      deferred2_1 = len1
      return getStringFromWasm0(ptr1, len1)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred2_0, deferred2_1, 1)
    }
  }
  /**
   * @param {string} group_id
   * @param {number} protocol_version
   * @param {string} ciphersuite
   * @param {number} threshold
   * @param {number} participants
   */
  constructor(group_id, protocol_version, ciphersuite, threshold, participants) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(group_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passStringToWasm0(ciphersuite, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      wasm.rostermanifest_new(
        retptr,
        ptr0,
        len0,
        protocol_version,
        ptr1,
        len1,
        threshold,
        participants
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      RosterManifestFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) RosterManifest.prototype[Symbol.dispose] = RosterManifest.prototype.free

/**
 * Sealed, authenticated messages between ceremony participants.
 *
 * The DKG needs this for its round-2 packages (handled internally), and KEYSET_SETUP needs it for
 * the `qsk`, which is the `nk`/`rivk` source and therefore a scanning secret: whoever relays it must
 * not read it.
 *
 * Both parties' static keys are known from the DKG, so sealing is a single message with no round
 * trip. `prologue` binds the participant set: a device that is shown a different roster derives a
 * different key schedule and cannot open the message.
 */
export class Sealed {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    SealedFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_sealed_free(ptr, 0)
  }
  /**
   * Open a message from `sender_public`. Fails if the pair, the ceremony or the bytes are wrong.
   * @param {Uint8Array} recipient_secret
   * @param {Uint8Array} sender_public
   * @param {Uint8Array} prologue
   * @param {Uint8Array} ciphertext
   * @returns {Uint8Array}
   */
  static open(recipient_secret, sender_public, prologue, ciphertext) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(recipient_secret, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(sender_public, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(prologue, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      const ptr3 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_export)
      const len3 = WASM_VECTOR_LEN
      wasm.sealed_open(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The prologue for a participant set, given their static public keys by slot.
   * @param {MessageSet} statics
   * @returns {Uint8Array}
   */
  static prologue(statics) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      _assertClass(statics, MessageSet)
      wasm.sealed_prologue(retptr, statics.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The prologue with the round-1 transcript folded in: the roster plus what each participant said.
   *
   * Use this instead of `prologue` once round-1 broadcasts exist. A coordinator that relays a different
   * round-1 set to different devices then cannot have its round-2 packages opened, because each device
   * seals under the transcript it was actually shown.
   * @param {MessageSet} statics
   * @param {MessageSet} round1
   * @returns {Uint8Array}
   */
  static prologueWithTranscript(statics, round1) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      _assertClass(statics, MessageSet)
      _assertClass(round1, MessageSet)
      wasm.sealed_prologueWithTranscript(retptr, statics.__wbg_ptr, round1.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Seal `plaintext` so only the holder of `recipient_public` can read it.
   * @param {Uint8Array} sender_secret
   * @param {Uint8Array} recipient_public
   * @param {Uint8Array} prologue
   * @param {Uint8Array} plaintext
   * @returns {Uint8Array}
   */
  static seal(sender_secret, recipient_public, prologue, plaintext) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(sender_secret, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(recipient_public, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(prologue, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      const ptr3 = passArray8ToWasm0(plaintext, wasm.__wbindgen_export)
      const len3 = WASM_VECTOR_LEN
      wasm.sealed_seal(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Sealed.prototype[Symbol.dispose] = Sealed.prototype.free

export class SeedFingerprint {
  static __wrap(ptr) {
    const obj = Object.create(SeedFingerprint.prototype)
    obj.__wbg_ptr = ptr
    SeedFingerprintFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    SeedFingerprintFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_seedfingerprint_free(ptr, 0)
  }
  /**
   * @param {Uint8Array} bytes
   * @returns {SeedFingerprint}
   */
  static from_bytes(bytes) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.seedfingerprint_from_bytes(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return SeedFingerprint.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {Uint8Array} seed
   */
  constructor(seed) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.seedfingerprint_new(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      SeedFingerprintFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {Uint8Array}
   */
  to_bytes() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.seedfingerprint_to_bytes(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var v1 = getArrayU8FromWasm0(r0, r1).slice()
      wasm.__wbindgen_export4(r0, r1 * 1, 1)
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) SeedFingerprint.prototype[Symbol.dispose] = SeedFingerprint.prototype.free

/**
 * Session marker helpers: what the host persists to know a session was in flight.
 */
export class SessionMarker {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    SessionMarkerFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_sessionmarker_free(ptr, 0)
  }
  /**
   * Advance a marker once commitments have left the device.
   * @param {Uint8Array} session_id
   * @returns {Uint8Array}
   */
  static committed(session_id) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.sessionmarker_committed(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Build the marker to persist right after a session starts.
   * @param {Uint8Array} session_id
   * @returns {Uint8Array}
   */
  static created(session_id) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.sessionmarker_created(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * What to do about a persisted marker: `"clean"`, `"discardable"` or `"burned"`.
   * @param {Uint8Array | null} [marker]
   * @returns {string}
   */
  static recover(marker) {
    let deferred3_0
    let deferred3_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      var ptr0 = isLikeNone(marker) ? 0 : passArray8ToWasm0(marker, wasm.__wbindgen_export)
      var len0 = WASM_VECTOR_LEN
      wasm.sessionmarker_recover(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      var ptr2 = r0
      var len2 = r1
      if (r3) {
        ptr2 = 0
        len2 = 0
        throw takeObject(r2)
      }
      deferred3_0 = ptr2
      deferred3_1 = len2
      return getStringFromWasm0(ptr2, len2)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1)
    }
  }
  /**
   * The session a marker refers to, as 16 bytes, or `None` when clean.
   * @param {Uint8Array | null} [marker]
   * @returns {Uint8Array | undefined}
   */
  static session_id(marker) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      var ptr0 = isLikeNone(marker) ? 0 : passArray8ToWasm0(marker, wasm.__wbindgen_export)
      var len0 = WASM_VECTOR_LEN
      wasm.sessionmarker_session_id(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) SessionMarker.prototype[Symbol.dispose] = SessionMarker.prototype.free

/**
 * A device's key share, bound to a group and slot.
 */
export class ShareBackup {
  static __wrap(ptr) {
    const obj = Object.create(ShareBackup.prototype)
    obj.__wbg_ptr = ptr
    ShareBackupFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    ShareBackupFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_sharebackup_free(ptr, 0)
  }
  /**
   * @returns {Uint8Array}
   */
  device_id() {
    const ret = wasm.sharebackup_device_id(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * Load and validate against the expected group and slot.
   * @param {Uint8Array} bytes
   * @param {Uint8Array} group_verifying_key
   * @param {number} expected_slot
   * @returns {ShareBackup}
   */
  static from_bytes(bytes, group_verifying_key, expected_slot) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.sharebackup_from_bytes(retptr, ptr0, len0, ptr1, len1, expected_slot)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return ShareBackup.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Rebuild a share from a 32-byte signing scalar plus the group's public data.
   *
   * This is the 24-word path: a BIP39 mnemonic carries 256 bits, which fits the scalar and nothing
   * else. The identifier and verifying share are derived from `slot` and the scalar, and `ak` /
   * `min_signers` come from the group's public state, which is not secret.
   *
   * **Pass `publicKeyPackage` whenever you have it.** With it, the reconstructed share is checked
   * against the group's record for this slot, so a wrong scalar fails here instead of producing
   * signature shares that never aggregate.
   * @param {Uint8Array} signing_scalar
   * @param {Uint8Array} group_verifying_key
   * @param {number} slot
   * @param {number} min_signers
   * @param {Uint8Array} device_id
   * @param {Uint8Array} vault_id
   * @param {Uint8Array | null} [public_key_package]
   * @returns {ShareBackup}
   */
  static from_scalar(
    signing_scalar,
    group_verifying_key,
    slot,
    min_signers,
    device_id,
    vault_id,
    public_key_package
  ) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(signing_scalar, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(device_id, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      const ptr3 = passArray8ToWasm0(vault_id, wasm.__wbindgen_export)
      const len3 = WASM_VECTOR_LEN
      var ptr4 = isLikeNone(public_key_package)
        ? 0
        : passArray8ToWasm0(public_key_package, wasm.__wbindgen_export)
      var len4 = WASM_VECTOR_LEN
      wasm.sharebackup_from_scalar(
        retptr,
        ptr0,
        len0,
        ptr1,
        len1,
        slot,
        min_signers,
        ptr2,
        len2,
        ptr3,
        len3,
        ptr4,
        len4
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return ShareBackup.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {Uint8Array}
   */
  group_verifying_key() {
    const ret = wasm.sharebackup_group_verifying_key(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * The key package, for handing to a [`SignerSession`]. Kept out of `to_bytes` on purpose: the
   * backup blob is what the host stores, not what it needs in memory.
   * @returns {Uint8Array}
   */
  key_package() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.sharebackup_key_package(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Wrap a key package for storage. `device_id` and `vault_id` are opaque to the wasm and must be
   * stable across restores.
   * @param {Uint8Array} key_package
   * @param {number} slot
   * @param {Uint8Array} device_id
   * @param {Uint8Array} vault_id
   * @param {Uint8Array} group_verifying_key
   */
  constructor(key_package, slot, device_id, vault_id, group_verifying_key) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(key_package, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(device_id, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(vault_id, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      const ptr3 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len3 = WASM_VECTOR_LEN
      wasm.sharebackup_new(retptr, ptr0, len0, slot, ptr1, len1, ptr2, len2, ptr3, len3)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      ShareBackupFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * The 32-byte signing scalar, for a 24-word backup.
   *
   * This is all a BIP39 mnemonic can carry (256 bits); `from_scalar` rebuilds the rest from public
   * data. **Drop the reference as soon as the words are encoded** — do not keep it, return it, or log
   * it.
   * @returns {Uint8Array}
   */
  signing_scalar() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.sharebackup_signing_scalar(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {number}
   */
  slot() {
    const ret = wasm.sharebackup_slot(this.__wbg_ptr)
    return ret
  }
  /**
   * Bytes for the host to seal and store. The wasm does not encrypt.
   * @returns {Uint8Array}
   */
  to_bytes() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.sharebackup_to_bytes(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {Uint8Array}
   */
  vault_id() {
    const ret = wasm.sharebackup_vault_id(this.__wbg_ptr)
    return takeObject(ret)
  }
}
if (Symbol.dispose) ShareBackup.prototype[Symbol.dispose] = ShareBackup.prototype.free

/**
 * Signer side of a signing session. Holds the key share and the nonces.
 */
export class Signer {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    SignerFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_signer_free(ptr, 0)
  }
  /**
   * Record that the user approved. Only after this can a share exist.
   */
  approve() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.signer_approve(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Consume `SIGN_INIT`, produce the `SIGN_COMMITMENTS` envelope to send back.
   * @param {Uint8Array} envelope
   * @returns {Uint8Array}
   */
  init(envelope) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.signer_init(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {Uint8Array} session_id
   * @param {number} my_slot
   * @param {number} participants
   * @param {Uint8Array} key_package
   */
  constructor(session_id, my_slot, participants, key_package) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(session_id, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(key_package, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.signer_new(retptr, ptr0, len0, my_slot, participants, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      SignerFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * `"committed"` / `"consumed"` per action, so the host can persist the nonce state.
   * @returns {Uint8Array}
   */
  nonce_states() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.signer_nonce_states(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var v1 = getArrayU8FromWasm0(r0, r1).slice()
      wasm.__wbindgen_export4(r0, r1 * 1, 1)
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Accept the coordinator's outcome report: `[status, txid | null, note]`.
   * @param {Uint8Array} envelope
   * @returns {Array<any>}
   */
  on_result(envelope) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.signer_on_result(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Consume `SIGN_PAYLOAD`. Returns `[sighash: Uint8Array, alphas: Uint8Array]` for the caller to
   * verify against the PCZT **before** approving.
   * @param {Uint8Array} envelope
   * @returns {Array<any>}
   */
  payload(envelope) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(envelope, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.signer_payload(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {string}
   */
  phase() {
    let deferred1_0
    let deferred1_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.signer_phase(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      deferred1_0 = r0
      deferred1_1 = r1
      return getStringFromWasm0(r0, r1)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1)
    }
  }
  /**
   * Refuse to sign, and end the session. `code`: 1 = user declined, 2 = verification failed,
   * 3 = malformed payload, 4 = expired.
   * @param {number} code
   * @param {string} note
   * @returns {Uint8Array}
   */
  reject(code, note) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(note, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.signer_reject(retptr, this.__wbg_ptr, code, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Produce the `SIGN_SHARE` envelope. Consumes the nonces.
   * @returns {Uint8Array}
   */
  share() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.signer_share(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Signer.prototype[Symbol.dispose] = Signer.prototype.free

export class TransactionRequest {
  static __wrap(ptr) {
    const obj = Object.create(TransactionRequest.prototype)
    obj.__wbg_ptr = ptr
    TransactionRequestFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    TransactionRequestFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_transactionrequest_free(ptr, 0)
  }
  /**
   * @returns {TransactionRequest}
   */
  static empty() {
    const ret = wasm.transactionrequest_empty()
    return TransactionRequest.__wrap(ret)
  }
  /**
   * @param {string} uri
   * @returns {TransactionRequest}
   */
  static from_uri(uri) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(uri, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.transactionrequest_from_uri(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return TransactionRequest.__wrap(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {PaymentRequest[]} payments
   */
  constructor(payments) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArrayJsValueToWasm0(payments, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      wasm.transactionrequest_new(retptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      TransactionRequestFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {PaymentRequest[]}
   */
  payment_requests() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.transactionrequest_payment_requests(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var v1 = getArrayJsValueFromWasm0(r0, r1).slice()
      wasm.__wbindgen_export4(r0, r1 * 4, 4)
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {string}
   */
  to_uri() {
    let deferred1_0
    let deferred1_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.transactionrequest_to_uri(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      deferred1_0 = r0
      deferred1_1 = r1
      return getStringFromWasm0(r0, r1)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1)
    }
  }
  /**
   * @returns {bigint}
   */
  total() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.transactionrequest_total(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getBigInt64(retptr + 8 * 0, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      if (r3) {
        throw takeObject(r2)
      }
      return BigInt.asUintN(64, r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) TransactionRequest.prototype[Symbol.dispose] = TransactionRequest.prototype.free

/**
 * A Zcash viewing key
 *
 * This is a wrapper around the `zcash_keys::keys::ViewingKey` type.
 * UFVKs should be generated from a spending key by calling `to_unified_full_viewing_key`
 * They can also be encoded and decoded to a canonical string representation
 */
export class UnifiedFullViewingKey {
  static __wrap(ptr) {
    const obj = Object.create(UnifiedFullViewingKey.prototype)
    obj.__wbg_ptr = ptr
    UnifiedFullViewingKeyFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    UnifiedFullViewingKeyFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_unifiedfullviewingkey_free(ptr, 0)
  }
  /**
   * @param {string} network
   * @returns {string}
   */
  encode(network) {
    let deferred3_0
    let deferred3_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.unifiedfullviewingkey_encode(retptr, this.__wbg_ptr, ptr0, len0)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      var ptr2 = r0
      var len2 = r1
      if (r3) {
        ptr2 = 0
        len2 = 0
        throw takeObject(r2)
      }
      deferred3_0 = ptr2
      deferred3_1 = len2
      return getStringFromWasm0(ptr2, len2)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1)
    }
  }
  /**
   * @param {string} network
   * @param {string} encoding
   */
  constructor(network, encoding) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passStringToWasm0(encoding, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      wasm.unifiedfullviewingkey_new(retptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      UnifiedFullViewingKeyFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose)
  UnifiedFullViewingKey.prototype[Symbol.dispose] = UnifiedFullViewingKey.prototype.free

export class UnifiedSpendingKey {
  static __wrap(ptr) {
    const obj = Object.create(UnifiedSpendingKey.prototype)
    obj.__wbg_ptr = ptr
    UnifiedSpendingKeyFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    UnifiedSpendingKeyFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_unifiedspendingkey_free(ptr, 0)
  }
  /**
   * Construct a new UnifiedSpendingKey
   *
   * # Arguments
   *
   * * `network` - Must be either "main" or "test"
   * * `seed` - At least 32 bytes of entry. Care should be taken as to how this is derived
   * * `hd_index` - [ZIP32](https://zips.z.cash/zip-0032) hierarchical deterministic index of the account
   * @param {string} network
   * @param {Uint8Array} seed
   * @param {number} hd_index
   */
  constructor(network, seed, hd_index) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(seed, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.unifiedspendingkey_new(retptr, ptr0, len0, ptr1, len1, hd_index)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      UnifiedSpendingKeyFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {ProofGenerationKey}
   */
  to_sapling_proof_generation_key() {
    const ret = wasm.unifiedspendingkey_to_sapling_proof_generation_key(this.__wbg_ptr)
    return ProofGenerationKey.__wrap(ret)
  }
  /**
   * Obtain the UFVK corresponding to this spending key
   * @returns {UnifiedFullViewingKey}
   */
  to_unified_full_viewing_key() {
    const ret = wasm.unifiedspendingkey_to_unified_full_viewing_key(this.__wbg_ptr)
    return UnifiedFullViewingKey.__wrap(ret)
  }
}
if (Symbol.dispose) UnifiedSpendingKey.prototype[Symbol.dispose] = UnifiedSpendingKey.prototype.free

/**
 * Verification helpers the frontend needs before it broadcasts anything.
 */
export class Verification {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    VerificationFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_verification_free(ptr, 0)
  }
  /**
   * `rk = ak + alpha·G`, as the transaction carries it.
   * @param {Uint8Array} group_verifying_key
   * @param {Uint8Array} alpha
   * @returns {Uint8Array}
   */
  static rk(group_verifying_key, alpha) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(alpha, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      wasm.verification_rk(retptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * Check an aggregated spend authorization signature. Run this before broadcasting.
   * @param {Uint8Array} group_verifying_key
   * @param {Uint8Array} alpha
   * @param {Uint8Array} message
   * @param {Uint8Array} signature
   */
  static verify_spend_auth(group_verifying_key, alpha, message, signature) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passArray8ToWasm0(group_verifying_key, wasm.__wbindgen_export)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passArray8ToWasm0(alpha, wasm.__wbindgen_export)
      const len1 = WASM_VECTOR_LEN
      const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_export)
      const len2 = WASM_VECTOR_LEN
      const ptr3 = passArray8ToWasm0(signature, wasm.__wbindgen_export)
      const len3 = WASM_VECTOR_LEN
      wasm.verification_verify_spend_auth(retptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) Verification.prototype[Symbol.dispose] = Verification.prototype.free

export class WalletSummary {
  static __wrap(ptr) {
    const obj = Object.create(WalletSummary.prototype)
    obj.__wbg_ptr = ptr
    WalletSummaryFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  toJSON() {
    return {
      chain_tip_height: this.chain_tip_height,
      fully_scanned_height: this.fully_scanned_height,
      next_ironwood_subtree_index: this.next_ironwood_subtree_index,
      next_orchard_subtree_index: this.next_orchard_subtree_index,
      next_sapling_subtree_index: this.next_sapling_subtree_index,
      account_balances: this.account_balances
    }
  }
  toString() {
    return JSON.stringify(this)
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    WalletSummaryFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_walletsummary_free(ptr, 0)
  }
  /**
   * @returns {number}
   */
  get chain_tip_height() {
    const ret = wasm.__wbg_get_walletsummary_chain_tip_height(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @returns {number}
   */
  get fully_scanned_height() {
    const ret = wasm.__wbg_get_walletsummary_fully_scanned_height(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @returns {bigint}
   */
  get next_ironwood_subtree_index() {
    const ret = wasm.__wbg_get_walletsummary_next_ironwood_subtree_index(this.__wbg_ptr)
    return BigInt.asUintN(64, ret)
  }
  /**
   * @returns {bigint}
   */
  get next_orchard_subtree_index() {
    const ret = wasm.__wbg_get_walletsummary_next_orchard_subtree_index(this.__wbg_ptr)
    return BigInt.asUintN(64, ret)
  }
  /**
   * @returns {bigint}
   */
  get next_sapling_subtree_index() {
    const ret = wasm.__wbg_get_walletsummary_next_sapling_subtree_index(this.__wbg_ptr)
    return BigInt.asUintN(64, ret)
  }
  /**
   * @param {number} arg0
   */
  set chain_tip_height(arg0) {
    wasm.__wbg_set_walletsummary_chain_tip_height(this.__wbg_ptr, arg0)
  }
  /**
   * @param {number} arg0
   */
  set fully_scanned_height(arg0) {
    wasm.__wbg_set_walletsummary_fully_scanned_height(this.__wbg_ptr, arg0)
  }
  /**
   * @param {bigint} arg0
   */
  set next_ironwood_subtree_index(arg0) {
    wasm.__wbg_set_walletsummary_next_ironwood_subtree_index(this.__wbg_ptr, arg0)
  }
  /**
   * @param {bigint} arg0
   */
  set next_orchard_subtree_index(arg0) {
    wasm.__wbg_set_walletsummary_next_orchard_subtree_index(this.__wbg_ptr, arg0)
  }
  /**
   * @param {bigint} arg0
   */
  set next_sapling_subtree_index(arg0) {
    wasm.__wbg_set_walletsummary_next_sapling_subtree_index(this.__wbg_ptr, arg0)
  }
  /**
   * @returns {any}
   */
  get account_balances() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.walletsummary_account_balances(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      return takeObject(r0)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
}
if (Symbol.dispose) WalletSummary.prototype[Symbol.dispose] = WalletSummary.prototype.free

export class WebVotingSession {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    WebVotingSessionFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_webvotingsession_free(ptr, 0)
  }
  /**
   * @param {string} round_id
   * @returns {VotingEligibility}
   */
  checkEligibility(round_id) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webvotingsession_checkEligibility(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * The host obtains explicit user confirmation naming this round before calling.
   * @param {string} round_id
   * @returns {Promise<void>}
   */
  clearRound(round_id) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webvotingsession_clearRound(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @returns {VotingDiscovery}
   */
  discoverRounds() {
    const ret = wasm.webvotingsession_discoverRounds(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * @returns {Uint8Array}
   */
  exportState() {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.webvotingsession_exportState(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      if (r3) {
        throw takeObject(r2)
      }
      var v1 = getArrayU8FromWasm0(r0, r1).slice()
      wasm.__wbindgen_export4(r0, r1 * 1, 1)
      return v1
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {WebWallet} wallet
   * @param {number} account_id
   * @param {Uint8Array | null | undefined} voting_db_bytes
   * @param {VotingCheckpoint} persist_checkpoint
   */
  constructor(wallet, account_id, voting_db_bytes, persist_checkpoint) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      _assertClass(wallet, WebWallet)
      var ptr0 = isLikeNone(voting_db_bytes)
        ? 0
        : passArray8ToWasm0(voting_db_bytes, wasm.__wbindgen_export)
      var len0 = WASM_VECTOR_LEN
      wasm.webvotingsession_new(
        retptr,
        wallet.__wbg_ptr,
        account_id,
        ptr0,
        len0,
        addHeapObject(persist_checkpoint)
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      WebVotingSessionFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {string} round_id
   * @returns {PreparedVotingRound}
   */
  prepareRound(round_id) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webvotingsession_prepareRound(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @param {string} round_id
   * @returns {VotingActionResult}
   */
  resumeRound(round_id) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webvotingsession_resumeRound(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @param {string} round_id
   * @returns {VotingProposal[]}
   */
  roundProposals(round_id) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webvotingsession_roundProposals(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @param {string} round_id
   * @returns {VotingRoundStatus}
   */
  roundStatus(round_id) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webvotingsession_roundStatus(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @returns {string}
   */
  get storageKey() {
    let deferred1_0
    let deferred1_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.webvotingsession_storageKey(retptr, this.__wbg_ptr)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      deferred1_0 = r0
      deferred1_1 = r1
      return getStringFromWasm0(r0, r1)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1)
    }
  }
  /**
   * @param {string} round_id
   * @param {BallotDecision[]} decisions
   * @returns {VotingActionResult}
   */
  submitBallot(round_id, decisions) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webvotingsession_submitBallot(
      this.__wbg_ptr,
      ptr0,
      len0,
      addHeapObject(decisions)
    )
    return takeObject(ret)
  }
  /**
   * @param {string} round_id
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fingerprint
   * @returns {VotingActionResult}
   */
  submitDelegation(round_id, usk, seed_fingerprint) {
    const ptr0 = passStringToWasm0(round_id, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    _assertClass(seed_fingerprint, SeedFingerprint)
    var ptr2 = seed_fingerprint.__destroy_into_raw()
    const ret = wasm.webvotingsession_submitDelegation(this.__wbg_ptr, ptr0, len0, ptr1, ptr2)
    return takeObject(ret)
  }
}
if (Symbol.dispose) WebVotingSession.prototype[Symbol.dispose] = WebVotingSession.prototype.free

export class WebWallet {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    WebWalletFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_webwallet_free(ptr, 0)
  }
  /**
   * Benchmark helper: download a block range over gRPC-web without scanning.
   * Returns the number of blocks fetched. Used to probe download throughput.
   * @param {number} start_height
   * @param {number} count
   * @returns {Promise<number>}
   */
  bench_download_range(start_height, count) {
    const ret = wasm.webwallet_bench_download_range(this.__wbg_ptr, start_height, count)
    return takeObject(ret)
  }
  /**
   * Benchmark helper: one baseline journal batch with per-stage timings (ms)
   * as JSON `{"subtree","setup","download","scan"}`, or undefined when synced.
   * When `refresh` is false, session setup is skipped (call
   * `sync_session_setup` once first).
   * @param {number | null | undefined} batch_size
   * @param {boolean} refresh
   * @returns {Promise<string | undefined>}
   */
  bench_prepare_sync_batch_timed(batch_size, refresh) {
    const ret = wasm.webwallet_bench_prepare_sync_batch_timed(
      this.__wbg_ptr,
      isLikeNone(batch_size) ? Number.MAX_SAFE_INTEGER : batch_size >>> 0,
      refresh
    )
    return takeObject(ret)
  }
  /**
   * @param {string} account_name
   * @param {string} seed_phrase
   * @param {number} account_hd_index
   * @param {number | null} [birthday_height]
   * @param {string | null} [passphrase]
   * @returns {Promise<number>}
   */
  create_account(account_name, seed_phrase, account_hd_index, birthday_height, passphrase) {
    const ptr0 = passStringToWasm0(account_name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(seed_phrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    var ptr2 = isLikeNone(passphrase)
      ? 0
      : passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    var len2 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_create_account(
      this.__wbg_ptr,
      ptr0,
      len0,
      ptr1,
      len1,
      account_hd_index,
      isLikeNone(birthday_height) ? Number.MAX_SAFE_INTEGER : birthday_height >>> 0,
      ptr2,
      len2
    )
    return takeObject(ret)
  }
  /**
   * Import a watch-only spending account from an encoded UFVK (hardware wallet flow).
   *
   * # Arguments
   * * `account_name` - Display name for the account
   * * `ufvk` - The encoded Unified Full Viewing Key exported by the device
   * * `seed_fingerprint` - 32-byte ZIP-32 seed fingerprint exported by the device
   * * `account_hd_index` - ZIP-32 account index on the device
   * * `birthday_height` - Block height to start scanning from
   * * `key_source` - Optional tag describing the key origin (e.g. "keystone")
   *
   * # Returns
   * The new account id
   * @param {string} account_name
   * @param {string} ufvk
   * @param {Uint8Array} seed_fingerprint
   * @param {number} account_hd_index
   * @param {number | null} [birthday_height]
   * @param {string | null} [key_source]
   * @returns {Promise<number>}
   */
  create_account_ufvk(
    account_name,
    ufvk,
    seed_fingerprint,
    account_hd_index,
    birthday_height,
    key_source
  ) {
    const ptr0 = passStringToWasm0(account_name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(ufvk, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    const ptr2 = passArray8ToWasm0(seed_fingerprint, wasm.__wbindgen_export)
    const len2 = WASM_VECTOR_LEN
    var ptr3 = isLikeNone(key_source)
      ? 0
      : passStringToWasm0(key_source, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    var len3 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_create_account_ufvk(
      this.__wbg_ptr,
      ptr0,
      len0,
      ptr1,
      len1,
      ptr2,
      len2,
      account_hd_index,
      isLikeNone(birthday_height) ? Number.MAX_SAFE_INTEGER : birthday_height >>> 0,
      ptr3,
      len3
    )
    return takeObject(ret)
  }
  /**
   * Create an unsigned, unproven PCZT for a transfer (hardware wallet flow).
   *
   * The returned PCZT carries ZIP-32 derivation metadata so an external signer
   * (e.g. Keystone) can locate its keys. Serialize it with `Pczt.serialize()`
   * before transporting via QR. `marginal_fee_zats` selects the ZIP-317 fee
   * tier so hardware sends honor the same dynamic-fee tiers as software sends.
   * Import a spending account from a UFVK with no ZIP-32 derivation (FROST vault flow).
   *
   * Use this for a vault whose FVK was produced by a DKG rather than a seed. Unlike
   * [`Self::create_account_ufvk`] there is no `seed_fingerprint`/`account_hd_index` to pass, and
   * none is invented: the account is recorded as having no derivation.
   * @param {string} account_name
   * @param {string} ufvk
   * @param {number | null} [birthday_height]
   * @param {string | null} [key_source]
   * @returns {Promise<number>}
   */
  create_account_ufvk_external(account_name, ufvk, birthday_height, key_source) {
    const ptr0 = passStringToWasm0(account_name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(ufvk, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    var ptr2 = isLikeNone(key_source)
      ? 0
      : passStringToWasm0(key_source, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    var len2 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_create_account_ufvk_external(
      this.__wbg_ptr,
      ptr0,
      len0,
      ptr1,
      len1,
      isLikeNone(birthday_height) ? Number.MAX_SAFE_INTEGER : birthday_height >>> 0,
      ptr2,
      len2
    )
    return takeObject(ret)
  }
  /**
   * @returns {Promise<Uint8Array>}
   */
  db_to_bytes() {
    const ret = wasm.webwallet_db_to_bytes(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * The callback must complete synchronously; returned Promises are not awaited.
   * A thrown value rejects this call unchanged.
   * @param {Function} callback
   * @returns {Promise<void>}
   */
  db_to_bytes_chunked(callback) {
    const ret = wasm.webwallet_db_to_bytes_chunked(this.__wbg_ptr, addHeapObject(callback))
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<bigint>}
   */
  estimate_orchard_migration_fee(account_id, to_address, memo, marginal_fee_zats) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_estimate_orchard_migration_fee(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      ptr1,
      len1,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<any>}
   */
  estimate_pczt_max_transfer(account_id, to_address, memo, marginal_fee_zats) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_estimate_pczt_max_transfer(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      ptr1,
      len1,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<any>}
   */
  estimate_pczt_max_transparent_transfer(account_id, to_address, memo, marginal_fee_zats) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_estimate_pczt_max_transparent_transfer(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      ptr1,
      len1,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<bigint>}
   */
  estimate_pczt_shield_fee(account_id, marginal_fee_zats) {
    const ret = wasm.webwallet_estimate_pczt_shield_fee(
      this.__wbg_ptr,
      account_id,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<bigint>}
   */
  estimate_pczt_transfer_fee(account_id, to_address, value, memo, marginal_fee_zats) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_estimate_pczt_transfer_fee(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      len1,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<bigint>}
   */
  estimate_pczt_transparent_transfer_fee(account_id, to_address, value, memo, marginal_fee_zats) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_estimate_pczt_transparent_transfer_fee(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      len1,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {"shielded" | "transparent"} funding_source
   * @param {Uint8Array | null} [memo]
   * @param {bigint | null} [marginal_fee_zats]
   * @param {number | null} [expiry_delta_blocks]
   * @returns {TransferEstimate}
   */
  estimate_transfer(
    account_id,
    to_address,
    value,
    funding_source,
    memo,
    marginal_fee_zats,
    expiry_delta_blocks
  ) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(funding_source, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    var ptr2 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len2 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_estimate_transfer(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      len1,
      ptr2,
      len2,
      !isLikeNone(marginal_fee_zats),
      isLikeNone(marginal_fee_zats) ? BigInt(0) : marginal_fee_zats,
      isLikeNone(expiry_delta_blocks) ? Number.MAX_SAFE_INTEGER : expiry_delta_blocks >>> 0
    )
    return takeObject(ret)
  }
  /**
   * Get the birthday height for a specific account
   *
   * # Arguments
   *
   * * `account_id` - The account ID to get the birthday height for
   *
   * # Returns
   *
   * The birthday height (block height) for the specified account
   *
   * # Example
   *
   * ```javascript
   * const accountId = 0;
   * const birthdayHeight = await wallet.get_account_birthday(accountId);
   * console.log(`Account ${accountId} birthday height: ${birthdayHeight}`);
   * ```
   * @param {number} account_id
   * @returns {Promise<number>}
   */
  get_account_birthday(account_id) {
    const ret = wasm.webwallet_get_account_birthday(this.__wbg_ptr, account_id)
    return takeObject(ret)
  }
  /**
   * Get the HD account index for an account.
   *
   * This returns the ZIP-32 account index that was used to derive this account's keys.
   * Returns None if the account was imported and doesn't have derivation info.
   *
   * # Arguments
   *
   * * `account_id` - The account ID
   *
   * # Returns
   *
   * The HD account index (u32), or None if not available
   * @param {number} account_id
   * @returns {Promise<number | undefined>}
   */
  get_account_hd_index(account_id) {
    const ret = wasm.webwallet_get_account_hd_index(this.__wbg_ptr, account_id)
    return takeObject(ret)
  }
  /**
   * Get account ID by account name
   *
   * # Arguments
   *
   * * `account_name` - The name of the account to find
   *
   * # Returns
   *
   * Returns the account ID as u32 if found
   *
   * # Example
   *
   * ```javascript
   * const accountId = await wallet.get_account_id_by_name("MyAccount");
   * console.log("Account ID:", accountId);
   * ```
   * @param {string} account_name
   * @returns {Promise<number>}
   */
  get_account_id_by_name(account_name) {
    const ptr0 = passStringToWasm0(account_name, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_get_account_id_by_name(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * Find the block height closest to a given Unix timestamp
   *
   * Uses binary search to efficiently locate the block height corresponding
   * to a specific time. Useful for determining wallet birthday heights based
   * on dates.
   *
   * # Arguments
   *
   * * `time` - Unix timestamp (seconds since epoch)
   *
   * # Returns
   *
   * Block height closest to the given timestamp (within ~1000 blocks precision)
   *
   * # Example
   *
   * ```javascript
   * // Find block height for January 1, 2024
   * const timestamp = Math.floor(new Date('2024-01-01').getTime() / 1000);
   * const height = await wallet.get_block_by_time(timestamp);
   * console.log(`Block height at 2024-01-01: ${height}`);
   *
   * // Use as birthday height when importing a wallet
   * const birthdayTimestamp = Math.floor(new Date('2023-06-15').getTime() / 1000);
   * const birthdayHeight = await wallet.get_block_by_time(birthdayTimestamp);
   * ```
   * @param {number} time
   * @returns {Promise<number>}
   */
  get_block_by_time(time) {
    const ret = wasm.webwallet_get_block_by_time(this.__wbg_ptr, time)
    return takeObject(ret)
  }
  /**
   * Get the Unix timestamp of a block at a given height
   *
   * # Arguments
   *
   * * `height` - The block height
   *
   * # Returns
   *
   * Unix timestamp (seconds since epoch) when the block was mined
   *
   * # Example
   *
   * ```javascript
   * const height = 2855000;
   * const timestamp = await wallet.get_block_time(height);
   * const date = new Date(timestamp * 1000);
   * console.log(`Block ${height} was mined at: ${date}`);
   * ```
   * @param {number} height
   * @returns {Promise<number>}
   */
  get_block_time(height) {
    const ret = wasm.webwallet_get_block_time(this.__wbg_ptr, height)
    return takeObject(ret)
  }
  /**
   * Returns the configured NU6.3 activation height for the selected network.
   * @returns {number | undefined}
   */
  get_ironwood_activation_height() {
    const ret = wasm.webwallet_get_ironwood_activation_height(this.__wbg_ptr)
    return ret === Number.MAX_SAFE_INTEGER ? undefined : ret
  }
  /**
   * @returns {Promise<bigint>}
   */
  get_latest_block() {
    const ret = wasm.webwallet_get_latest_block(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * Get the latest block height from the blockchain
   *
   * # Returns
   *
   * The current chain tip height
   *
   * # Example
   *
   * ```javascript
   * const latestHeight = await wallet.get_latest_height();
   * console.log(`Current blockchain height: ${latestHeight}`);
   * ```
   * @returns {Promise<number>}
   */
  get_latest_height() {
    const ret = wasm.webwallet_get_latest_height(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * Generate and persist the next shielded receiving address for an account.
   *
   * This returns a unified address containing the account's available shielded receivers
   * (Orchard/Sapling) and no transparent receiver. It advances the wallet's stored address
   * position, so callers should persist the wallet DB after using this method.
   *
   * # Arguments
   *
   * * `account_id` - The account ID to generate the next shielded address for
   *
   * # Returns
   *
   * Returns a UnifiedAddresses object. `transparent` and `address_index` will be null.
   * @param {number} account_id
   * @returns {Promise<any>}
   */
  get_next_shielded_address(account_id) {
    const ret = wasm.webwallet_get_next_shielded_address(this.__wbg_ptr, account_id)
    return takeObject(ret)
  }
  /**
   * The raw bytes of a stored transaction, or `undefined` when the wallet has no record of it.
   *
   * Lets a caller persist the exact transaction next to its own intent record rather than depending on
   * the wallet database alone.
   * @param {string} txid
   * @returns {Promise<Uint8Array | undefined>}
   */
  get_stored_transaction_bytes(txid) {
    const ptr0 = passStringToWasm0(txid, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_get_stored_transaction_bytes(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @returns {Promise<any>}
   */
  get_transaction_history(account_id) {
    const ret = wasm.webwallet_get_transaction_history(this.__wbg_ptr, account_id)
    return takeObject(ret)
  }
  /**
   * Get addresses for an account
   *
   * # Arguments
   *
   * * `account_id` - The account ID to get addresses for
   *
   * # Returns
   *
   * Returns a UnifiedAddresses object containing:
   * - unified: The shielded unified address (u1 format with Orchard/Sapling receivers only)
   * - orchard: Orchard-only unified address (if available)
   * - sapling: Sapling-only unified address (u1 format, if available)
   * - sapling_zs: Sapling traditional address (zs format, if available)
   * - transparent: Transparent P2PKH address (if available)
   *
   * # Example
   *
   * ```javascript
   * const addresses = await wallet.get_unified_addresses(accountId);
   * // Display the selected address in the wallet UI; avoid logging account addresses.
   * ```
   * @param {number} account_id
   * @returns {Promise<any>}
   */
  get_unified_addresses(account_id) {
    const ret = wasm.webwallet_get_unified_addresses(this.__wbg_ptr, account_id)
    return takeObject(ret)
  }
  /**
   * @returns {Promise<WalletSummary | undefined>}
   */
  get_wallet_summary() {
    const ret = wasm.webwallet_get_wallet_summary(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * List the user-facing shielded receiving addresses generated for an account.
   *
   * The wallet database also stores Unified Addresses used to discover transparent
   * receivers. Those internal records are excluded unless they are the account's default
   * address. Results are ordered by diversifier index from oldest to newest.
   * @param {number} account_id
   * @returns {Promise<any>}
   */
  list_shielded_addresses(account_id) {
    const ret = wasm.webwallet_list_shielded_addresses(this.__wbg_ptr, account_id)
    return takeObject(ret)
  }
  /**
   * The policy is runtime configuration. Supply it again when restoring db_bytes.
   * Omitting it or passing null uses ConfirmationsPolicy::default().
   * @param {string} network
   * @param {string} lightwalletd_url
   * @param {Uint8Array | null} [db_bytes]
   * @param {ConfirmationsPolicy | null} [confirmations_policy]
   * @param {CompactBlockCdnOptions | null} [compact_block_cdn]
   * @param {ZeroIndexerOptions | null} [zero_indexer_options]
   */
  constructor(
    network,
    lightwalletd_url,
    db_bytes,
    confirmations_policy,
    compact_block_cdn,
    zero_indexer_options
  ) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passStringToWasm0(
        lightwalletd_url,
        wasm.__wbindgen_export,
        wasm.__wbindgen_export2
      )
      const len1 = WASM_VECTOR_LEN
      var ptr2 = isLikeNone(db_bytes) ? 0 : passArray8ToWasm0(db_bytes, wasm.__wbindgen_export)
      var len2 = WASM_VECTOR_LEN
      wasm.webwallet_new(
        retptr,
        ptr0,
        len0,
        ptr1,
        len1,
        ptr2,
        len2,
        addHeapObject(confirmations_policy),
        addHeapObject(compact_block_cdn),
        addHeapObject(zero_indexer_options)
      )
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      if (r2) {
        throw takeObject(r1)
      }
      this.__wbg_ptr = r0
      WebWalletFinalization.register(this, this.__wbg_ptr, this)
      return this
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fp
   * @param {ProofGenerationKey | null | undefined} sapling_proof_gen_key
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @param {number | null} [expiry_delta_blocks]
   * @returns {Promise<string>}
   */
  oneclick_pczt_orchard_migration(
    account_id,
    to_address,
    usk,
    seed_fp,
    sapling_proof_gen_key,
    memo,
    marginal_fee_zats,
    expiry_delta_blocks
  ) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    _assertClass(seed_fp, SeedFingerprint)
    var ptr2 = seed_fp.__destroy_into_raw()
    let ptr3 = 0
    if (!isLikeNone(sapling_proof_gen_key)) {
      _assertClass(sapling_proof_gen_key, ProofGenerationKey)
      ptr3 = sapling_proof_gen_key.__destroy_into_raw()
    }
    var ptr4 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len4 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_oneclick_pczt_orchard_migration(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      ptr1,
      ptr2,
      ptr3,
      ptr4,
      len4,
      marginal_fee_zats,
      isLikeNone(expiry_delta_blocks) ? Number.MAX_SAFE_INTEGER : expiry_delta_blocks >>> 0
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fp
   * @param {ProofGenerationKey | null} [sapling_proof_gen_key]
   * @returns {Promise<string>}
   */
  oneclick_pczt_shield(account_id, usk, seed_fp, sapling_proof_gen_key) {
    _assertClass(usk, UnifiedSpendingKey)
    var ptr0 = usk.__destroy_into_raw()
    _assertClass(seed_fp, SeedFingerprint)
    var ptr1 = seed_fp.__destroy_into_raw()
    let ptr2 = 0
    if (!isLikeNone(sapling_proof_gen_key)) {
      _assertClass(sapling_proof_gen_key, ProofGenerationKey)
      ptr2 = sapling_proof_gen_key.__destroy_into_raw()
    }
    const ret = wasm.webwallet_oneclick_pczt_shield(this.__wbg_ptr, account_id, ptr0, ptr1, ptr2)
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fp
   * @param {ProofGenerationKey | null | undefined} sapling_proof_gen_key
   * @param {bigint} marginal_fee_zats
   * @param {number | null} [expiry_delta_blocks]
   * @returns {Promise<string>}
   */
  oneclick_pczt_shield_dynamic_fee(
    account_id,
    usk,
    seed_fp,
    sapling_proof_gen_key,
    marginal_fee_zats,
    expiry_delta_blocks
  ) {
    _assertClass(usk, UnifiedSpendingKey)
    var ptr0 = usk.__destroy_into_raw()
    _assertClass(seed_fp, SeedFingerprint)
    var ptr1 = seed_fp.__destroy_into_raw()
    let ptr2 = 0
    if (!isLikeNone(sapling_proof_gen_key)) {
      _assertClass(sapling_proof_gen_key, ProofGenerationKey)
      ptr2 = sapling_proof_gen_key.__destroy_into_raw()
    }
    const ret = wasm.webwallet_oneclick_pczt_shield_dynamic_fee(
      this.__wbg_ptr,
      account_id,
      ptr0,
      ptr1,
      ptr2,
      marginal_fee_zats,
      isLikeNone(expiry_delta_blocks) ? Number.MAX_SAFE_INTEGER : expiry_delta_blocks >>> 0
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fp
   * @param {ProofGenerationKey | null} [sapling_proof_gen_key]
   * @param {Uint8Array | null} [memo]
   * @returns {Promise<string>}
   */
  oneclick_pczt_transfer(account_id, to_address, value, usk, seed_fp, sapling_proof_gen_key, memo) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    _assertClass(seed_fp, SeedFingerprint)
    var ptr2 = seed_fp.__destroy_into_raw()
    let ptr3 = 0
    if (!isLikeNone(sapling_proof_gen_key)) {
      _assertClass(sapling_proof_gen_key, ProofGenerationKey)
      ptr3 = sapling_proof_gen_key.__destroy_into_raw()
    }
    var ptr4 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len4 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_oneclick_pczt_transfer(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      ptr2,
      ptr3,
      ptr4,
      len4
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fp
   * @param {ProofGenerationKey | null | undefined} sapling_proof_gen_key
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @param {number | null} [expiry_delta_blocks]
   * @returns {Promise<string>}
   */
  oneclick_pczt_transfer_dynamic_fee(
    account_id,
    to_address,
    value,
    usk,
    seed_fp,
    sapling_proof_gen_key,
    memo,
    marginal_fee_zats,
    expiry_delta_blocks
  ) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    _assertClass(seed_fp, SeedFingerprint)
    var ptr2 = seed_fp.__destroy_into_raw()
    let ptr3 = 0
    if (!isLikeNone(sapling_proof_gen_key)) {
      _assertClass(sapling_proof_gen_key, ProofGenerationKey)
      ptr3 = sapling_proof_gen_key.__destroy_into_raw()
    }
    var ptr4 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len4 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_oneclick_pczt_transfer_dynamic_fee(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      ptr2,
      ptr3,
      ptr4,
      len4,
      marginal_fee_zats,
      isLikeNone(expiry_delta_blocks) ? Number.MAX_SAFE_INTEGER : expiry_delta_blocks >>> 0
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fp
   * @param {ProofGenerationKey | null} [sapling_proof_gen_key]
   * @param {Uint8Array | null} [memo]
   * @returns {Promise<string>}
   */
  oneclick_pczt_transparent_transfer(
    account_id,
    to_address,
    value,
    usk,
    seed_fp,
    sapling_proof_gen_key,
    memo
  ) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    _assertClass(seed_fp, SeedFingerprint)
    var ptr2 = seed_fp.__destroy_into_raw()
    let ptr3 = 0
    if (!isLikeNone(sapling_proof_gen_key)) {
      _assertClass(sapling_proof_gen_key, ProofGenerationKey)
      ptr3 = sapling_proof_gen_key.__destroy_into_raw()
    }
    var ptr4 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len4 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_oneclick_pczt_transparent_transfer(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      ptr2,
      ptr3,
      ptr4,
      len4
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {UnifiedSpendingKey} usk
   * @param {SeedFingerprint} seed_fp
   * @param {ProofGenerationKey | null | undefined} sapling_proof_gen_key
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @param {number | null} [expiry_delta_blocks]
   * @returns {Promise<string>}
   */
  oneclick_pczt_transparent_transfer_dynamic_fee(
    account_id,
    to_address,
    value,
    usk,
    seed_fp,
    sapling_proof_gen_key,
    memo,
    marginal_fee_zats,
    expiry_delta_blocks
  ) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    _assertClass(seed_fp, SeedFingerprint)
    var ptr2 = seed_fp.__destroy_into_raw()
    let ptr3 = 0
    if (!isLikeNone(sapling_proof_gen_key)) {
      _assertClass(sapling_proof_gen_key, ProofGenerationKey)
      ptr3 = sapling_proof_gen_key.__destroy_into_raw()
    }
    var ptr4 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len4 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_oneclick_pczt_transparent_transfer_dynamic_fee(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      ptr2,
      ptr3,
      ptr4,
      len4,
      marginal_fee_zats,
      isLikeNone(expiry_delta_blocks) ? Number.MAX_SAFE_INTEGER : expiry_delta_blocks >>> 0
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {UnifiedSpendingKey} usk
   * @param {"shielded" | "transparent"} funding_source
   * @param {Uint8Array | null} [memo]
   * @param {bigint | null} [marginal_fee_zats]
   * @param {number | null} [expiry_delta_blocks]
   * @returns {TransferResult}
   */
  oneclick_transfer(
    account_id,
    to_address,
    value,
    usk,
    funding_source,
    memo,
    marginal_fee_zats,
    expiry_delta_blocks
  ) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    const ptr2 = passStringToWasm0(funding_source, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len2 = WASM_VECTOR_LEN
    var ptr3 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len3 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_oneclick_transfer(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      ptr2,
      len2,
      ptr3,
      len3,
      !isLikeNone(marginal_fee_zats),
      isLikeNone(marginal_fee_zats) ? BigInt(0) : marginal_fee_zats,
      isLikeNone(expiry_delta_blocks) ? Number.MAX_SAFE_INTEGER : expiry_delta_blocks >>> 0
    )
    return takeObject(ret)
  }
  /**
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<Pczt>}
   */
  pczt_create(account_id, to_address, value, memo, marginal_fee_zats) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_pczt_create(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      len1,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * Create an unsigned, unproven PCZT funded only by transparent inputs.
   * `marginal_fee_zats` selects the ZIP-317 fee tier, matching software sends.
   * @param {number} account_id
   * @param {string} to_address
   * @param {bigint} value
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<Pczt>}
   */
  pczt_create_transparent(account_id, to_address, value, memo, marginal_fee_zats) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_pczt_create_transparent(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      value,
      ptr1,
      len1,
      marginal_fee_zats
    )
    return takeObject(ret)
  }
  /**
   * Create a V6 PCZT that sweeps spendable Orchard funds to this account's Ironwood pool.
   * @param {number} account_id
   * @param {string} to_address
   * @param {Uint8Array | null | undefined} memo
   * @param {bigint} marginal_fee_zats
   * @param {number | null} [expiry_delta_blocks]
   * @returns {Promise<Pczt>}
   */
  pczt_orchard_migration_create(
    account_id,
    to_address,
    memo,
    marginal_fee_zats,
    expiry_delta_blocks
  ) {
    const ptr0 = passStringToWasm0(to_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    var ptr1 = isLikeNone(memo) ? 0 : passArray8ToWasm0(memo, wasm.__wbindgen_export)
    var len1 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_pczt_orchard_migration_create(
      this.__wbg_ptr,
      account_id,
      ptr0,
      len0,
      ptr1,
      len1,
      marginal_fee_zats,
      isLikeNone(expiry_delta_blocks) ? Number.MAX_SAFE_INTEGER : expiry_delta_blocks >>> 0
    )
    return takeObject(ret)
  }
  /**
   * Prove an externally signed PCZT **without sending it**.
   *
   * Hardware-wallet and vault accounts never hold Sapling notes, so no Sapling proof generation key is
   * needed.
   *
   * # Returns
   * The proved PCZT, ready for `pczt_store`
   * @param {Pczt} pczt
   * @returns {Promise<Pczt>}
   */
  pczt_prove(pczt) {
    _assertClass(pczt, Pczt)
    var ptr0 = pczt.__destroy_into_raw()
    const ret = wasm.webwallet_pczt_prove(this.__wbg_ptr, ptr0)
    return takeObject(ret)
  }
  /**
   * Prove and broadcast an externally signed PCZT (hardware wallet flow).
   *
   * Hardware-wallet accounts never hold Sapling notes (Keystone supports
   * transparent + Orchard only), so no Sapling proof generation key is needed.
   *
   * # Returns
   * Transaction ID string on success
   * @param {Pczt} pczt
   * @returns {Promise<string>}
   */
  pczt_prove_and_send(pczt) {
    _assertClass(pczt, Pczt)
    var ptr0 = pczt.__destroy_into_raw()
    const ret = wasm.webwallet_pczt_prove_and_send(this.__wbg_ptr, ptr0)
    return takeObject(ret)
  }
  /**
   * Create an unsigned, unproven shielding PCZT (transparent -> Orchard) for
   * external signing (hardware wallet flow). `marginal_fee_zats` selects the
   * ZIP-317 fee tier so hardware shields honor the dynamic-fee tiers too.
   * @param {number} account_id
   * @param {bigint} marginal_fee_zats
   * @returns {Promise<Pczt>}
   */
  pczt_shield_create(account_id, marginal_fee_zats) {
    const ret = wasm.webwallet_pczt_shield_create(this.__wbg_ptr, account_id, marginal_fee_zats)
    return takeObject(ret)
  }
  /**
   * Finalize a proved PCZT and store the transaction, **without broadcasting**.
   *
   * This is the point where a caller can obtain a stable transaction id and the transaction itself
   * before anything reaches the network. After it returns, the transaction is in the wallet database
   * and can be submitted later by txid with `send_authorized_transactions` — including after a restart,
   * if the database itself survived.
   *
   * # Returns
   * Transaction ID string (lowercase hex, display order — the same order as `txid` on explorers)
   * @param {Pczt} pczt
   * @returns {Promise<string>}
   */
  pczt_store(pczt) {
    _assertClass(pczt, Pczt)
    var ptr0 = pczt.__destroy_into_raw()
    const ret = wasm.webwallet_pczt_store(this.__wbg_ptr, ptr0)
    return takeObject(ret)
  }
  /**
   * Finalize a proved PCZT, store it, and return everything a caller must persist before submitting.
   *
   * Returns `{ txId, rawTxSha256, rawTxLen, network }`:
   *
   * * `txId` — display-order lowercase hex, the same id explorers show.
   * * `rawTxSha256` — SHA-256 of the stored transaction bytes, lowercase hex. It identifies *the bytes you
   *   stored*: finalizing the same PCZT twice yields the same `txId` and different bytes, so this digest
   *   cannot be compared across two separate finalizations.
   * * `rawTxLen` — byte length of the stored transaction.
   * * `network` — the wallet's configured network (`"mainnet"` / `"testnet"`). This is configuration, not a
   *   proof read out of the transaction.
   *
   * The account id is deliberately absent: the PCZT's proposal metadata that records it is private to the
   * wallet backend, so we cannot read it back. A caller that needs the binding must keep its own record.
   * @param {Pczt} pczt
   * @returns {Promise<any>}
   */
  pczt_store_detailed(pczt) {
    _assertClass(pczt, Pczt)
    var ptr0 = pczt.__destroy_into_raw()
    const ret = wasm.webwallet_pczt_store_detailed(this.__wbg_ptr, ptr0)
    return takeObject(ret)
  }
  /**
   * Journal-aware sync: download + scan one batch, return journal data for persistence.
   * Returns null if fully synced, or Uint8Array with journal entry data.
   * When `refresh` is false, session setup is skipped (call `sync_session_setup`
   * once at the start of the catch-up session first).
   * @param {number | null | undefined} batch_size
   * @param {boolean} refresh
   * @returns {Promise<Uint8Array | undefined>}
   */
  prepare_sync_batch(batch_size, refresh) {
    const ret = wasm.webwallet_prepare_sync_batch(
      this.__wbg_ptr,
      isLikeNone(batch_size) ? Number.MAX_SAFE_INTEGER : batch_size >>> 0,
      refresh
    )
    return takeObject(ret)
  }
  /**
   * Optimized journal-aware sync: same as [`prepare_sync_batch`] but uses
   * External-only IVK scanning for contiguous forward ranges.
   * @param {number | null} [batch_size]
   * @returns {Promise<Uint8Array | undefined>}
   */
  prepare_sync_batch_optimized(batch_size) {
    const ret = wasm.webwallet_prepare_sync_batch_optimized(
      this.__wbg_ptr,
      isLikeNone(batch_size) ? Number.MAX_SAFE_INTEGER : batch_size >>> 0
    )
    return takeObject(ret)
  }
  /**
   * Replay multiple journal entries in sequence (for recovery).
   * @param {Uint8Array[]} entries
   * @returns {Promise<void>}
   */
  replay_journal_entries(entries) {
    const ptr0 = passArrayJsValueToWasm0(entries, wasm.__wbindgen_export)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_replay_journal_entries(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * Scan a journal entry for recovery (replay from base snapshot + journal).
   * Returns true if more scan ranges remain.
   * @param {Uint8Array} journal_data
   * @returns {Promise<boolean>}
   */
  scan_journal_entry(journal_data) {
    const ptr0 = passArray8ToWasm0(journal_data, wasm.__wbindgen_export)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_scan_journal_entry(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @param {Uint8Array} txids
   * @returns {TransferResult}
   */
  send_authorized_transactions(txids) {
    const ptr0 = passArray8ToWasm0(txids, wasm.__wbindgen_export)
    const len0 = WASM_VECTOR_LEN
    const ret = wasm.webwallet_send_authorized_transactions(this.__wbg_ptr, ptr0, len0)
    return takeObject(ret)
  }
  /**
   * @param {ZeroIndexerOptions | null} options
   */
  set_zero_indexer_options(options) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      wasm.webwallet_set_zero_indexer_options(retptr, this.__wbg_ptr, addHeapObject(options))
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
    }
  }
  /**
   * @returns {Promise<void>}
   */
  sync() {
    const ret = wasm.webwallet_sync(this.__wbg_ptr)
    return takeObject(ret)
  }
  /**
   * Runs a single batch of the sync process without looping.
   * Returns `true` if a scan range was processed, `false` if no scan ranges were suggested.
   * @param {number | null} [batch_size]
   * @returns {Promise<boolean>}
   */
  sync_next_batch(batch_size) {
    const ret = wasm.webwallet_sync_next_batch(
      this.__wbg_ptr,
      isLikeNone(batch_size) ? Number.MAX_SAFE_INTEGER : batch_size >>> 0
    )
    return takeObject(ret)
  }
  /**
   * Runs a single batch using the optimized scanning strategy.
   * Returns `true` if a scan range was processed, `false` if no scan ranges were suggested.
   * @param {number | null} [batch_size]
   * @returns {Promise<boolean>}
   */
  sync_next_batch_optimized(batch_size) {
    const ret = wasm.webwallet_sync_next_batch_optimized(
      this.__wbg_ptr,
      isLikeNone(batch_size) ? Number.MAX_SAFE_INTEGER : batch_size >>> 0
    )
    return takeObject(ret)
  }
  /**
   * Run session-level setup (subtree roots, chain tip, transparent UTXOs)
   * once before a multi-batch catch-up so subsequent batches can skip it.
   * @returns {Promise<void>}
   */
  sync_session_setup() {
    const ret = wasm.webwallet_sync_session_setup(this.__wbg_ptr)
    return takeObject(ret)
  }
}
if (Symbol.dispose) WebWallet.prototype[Symbol.dispose] = WebWallet.prototype.free

/**
 * Generate a new 24-word BIP-39 mnemonic phrase.
 *
 * # Arguments
 *
 * * `word_count` - Number of words in the mnemonic. Must be 24 for new wallet generation.
 *
 * # Returns
 *
 * A string containing the mnemonic phrase
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * // Show the phrase only in the wallet's protected backup flow; never log it.
 * ```
 * @param {number} word_count
 * @returns {string}
 */
export function generate_mnemonic(word_count) {
  let deferred2_0
  let deferred2_1
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    wasm.generate_mnemonic(retptr, word_count)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
    var ptr1 = r0
    var len1 = r1
    if (r3) {
      ptr1 = 0
      len1 = 0
      throw takeObject(r2)
    }
    deferred2_0 = ptr1
    deferred2_1 = len1
    return getStringFromWasm0(ptr1, len1)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
    wasm.__wbindgen_export4(deferred2_0, deferred2_1, 1)
  }
}

/**
 * @param {number} num_threads
 * @returns {Promise<any>}
 */
export function initThreadPool(num_threads) {
  const ret = wasm.initThreadPool(num_threads)
  return takeObject(ret)
}

/**
 * Get all addresses (shielded unified, orchard, sapling, transparent) from a mnemonic phrase.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 * * `account_index` - The account index for HD derivation (usually 0)
 *
 * # Returns
 *
 * A JSON object containing all address types
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * const addresses = mnemonic_to_addresses(
 *     "main",
 *     mnemonic,
 *     "",  // no passphrase
 *     0    // first account
 * );
 * // Display the selected receiver in the wallet UI; avoid logging account addresses.
 * ```
 * @param {string} network
 * @param {string} phrase
 * @param {string} passphrase
 * @param {number} account_index
 * @returns {any}
 */
export function mnemonic_to_addresses(network, phrase, passphrase, account_index) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(phrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    const ptr2 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len2 = WASM_VECTOR_LEN
    wasm.mnemonic_to_addresses(retptr, ptr0, len0, ptr1, len1, ptr2, len2, account_index)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    if (r2) {
      throw takeObject(r1)
    }
    return takeObject(r0)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Convert a mnemonic phrase to a seed with an optional passphrase.
 *
 * # Arguments
 *
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string for no passphrase)
 *
 * # Returns
 *
 * A 64-byte seed that can be used for key derivation
 *
 * # Example
 *
 * ```javascript
 * const seed = mnemonic_to_seed("abandon abandon abandon ... art", "");
 * // Use the seed for local key derivation; never log or persist it as plaintext.
 * ```
 * @param {string} phrase
 * @param {string} passphrase
 * @returns {Uint8Array}
 */
export function mnemonic_to_seed(phrase, passphrase) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(phrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    wasm.mnemonic_to_seed(retptr, ptr0, len0, ptr1, len1)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
    if (r3) {
      throw takeObject(r2)
    }
    var v3 = getArrayU8FromWasm0(r0, r1).slice()
    wasm.__wbindgen_export4(r0, r1 * 1, 1)
    return v3
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Generate a SeedFingerprint from a mnemonic phrase.
 *
 * # Arguments
 *
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 *
 * # Returns
 *
 * A SeedFingerprint that can be used for key derivation path identification
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * const seed_fp = mnemonic_to_seed_fingerprint(
 *     mnemonic,
 *     ""  // no passphrase
 * );
 * ```
 * @param {string} phrase
 * @param {string} passphrase
 * @returns {SeedFingerprint}
 */
export function mnemonic_to_seed_fingerprint(phrase, passphrase) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(phrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    wasm.mnemonic_to_seed_fingerprint(retptr, ptr0, len0, ptr1, len1)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    if (r2) {
      throw takeObject(r1)
    }
    return SeedFingerprint.__wrap(r0)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Generate a UnifiedSpendingKey from a mnemonic phrase.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 * * `account_index` - The account index for HD derivation (usually 0)
 *
 * # Returns
 *
 * A UnifiedSpendingKey that can be used for signing transactions
 *
 * # Example
 *
 * ```javascript
 * const mnemonic = generate_mnemonic(24);
 * const usk = mnemonic_to_spending_key(
 *     "main",
 *     mnemonic,
 *     "",  // no passphrase
 *     0    // first account
 * );
 * ```
 * @param {string} network
 * @param {string} phrase
 * @param {string} passphrase
 * @param {number} account_index
 * @returns {UnifiedSpendingKey}
 */
export function mnemonic_to_spending_key(network, phrase, passphrase, account_index) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(phrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    const ptr2 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len2 = WASM_VECTOR_LEN
    wasm.mnemonic_to_spending_key(retptr, ptr0, len0, ptr1, len1, ptr2, len2, account_index)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    if (r2) {
      throw takeObject(r1)
    }
    return UnifiedSpendingKey.__wrap(r0)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Get a transparent address and public key from a mnemonic at a specific external address index.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `phrase` - The mnemonic phrase
 * * `passphrase` - Optional passphrase (use empty string "" if none)
 * * `account_index` - The account index for HD derivation (usually 0)
 * * `address_index` - The external transparent child address index
 * @param {string} network
 * @param {string} phrase
 * @param {string} passphrase
 * @param {number} account_index
 * @param {number} address_index
 * @returns {any}
 */
export function mnemonic_to_transparent_address(
  network,
  phrase,
  passphrase,
  account_index,
  address_index
) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(phrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    const ptr2 = passStringToWasm0(passphrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len2 = WASM_VECTOR_LEN
    wasm.mnemonic_to_transparent_address(
      retptr,
      ptr0,
      len0,
      ptr1,
      len1,
      ptr2,
      len2,
      account_index,
      address_index
    )
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    if (r2) {
      throw takeObject(r1)
    }
    return takeObject(r0)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Parse a unified address string and extract individual receiver addresses.
 *
 * # Arguments
 *
 * * `network` - Network name ("main" or "test")
 * * `unified_address` - The unified address string to parse
 *
 * # Returns
 *
 * A JSON object containing individual address types extracted from the unified address
 *
 * # Example
 *
 * ```javascript
 * const addresses = parse_unified_address(
 *     "main",
 *     "u1..." // unified address string
 * );
 * // Select the receiver needed by the payment flow; avoid logging addresses.
 * ```
 * @param {string} network
 * @param {string} unified_address
 * @returns {any}
 */
export function parse_unified_address(network, unified_address) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    const ptr1 = passStringToWasm0(unified_address, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len1 = WASM_VECTOR_LEN
    wasm.parse_unified_address(retptr, ptr0, len0, ptr1, len1)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    if (r2) {
      throw takeObject(r1)
    }
    return takeObject(r0)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Sign a message with the transparent address private key
 *
 * This implements the Bitcoin/Zcash message signing convention compatible with
 * the `signmessage` RPC call.
 *
 * # Arguments
 *
 * * `network` - Network type ("main" or "test")
 * * `usk` - The Unified Spending Key
 * * `message` - The message to sign
 * * `address_index` - Optional external transparent address index to sign with. If omitted, the default full unified address index is used.
 *
 * # Returns
 *
 * Returns a JSON object with:
 * - signature: Hex-encoded signature (65 bytes: recovery_id + r + s)
 * - pubkey: Hex-encoded uncompressed public key (65 bytes: 04 + x + y)
 * - address: The transparent address used for signing
 *
 * # Example
 *
 * ```javascript
 * const result = await sign_message_with_transparent("main", usk, "Hello Zcash!", undefined);
 * // Return the signature to the requesting flow; avoid logging account identifiers.
 * ```
 * @param {string} network
 * @param {UnifiedSpendingKey} usk
 * @param {string} message
 * @param {number | null} [address_index]
 * @returns {any}
 */
export function sign_message_with_transparent(network, usk, message, address_index) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(network, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    _assertClass(usk, UnifiedSpendingKey)
    var ptr1 = usk.__destroy_into_raw()
    const ptr2 = passStringToWasm0(message, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len2 = WASM_VECTOR_LEN
    wasm.sign_message_with_transparent(
      retptr,
      ptr0,
      len0,
      ptr1,
      ptr2,
      len2,
      isLikeNone(address_index) ? Number.MAX_SAFE_INTEGER : address_index >>> 0
    )
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
    if (r2) {
      throw takeObject(r1)
    }
    return takeObject(r0)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Which signing phase a session is in, for logging.
 * @returns {Array<any>}
 */
export function signing_phases() {
  const ret = wasm.signing_phases()
  return takeObject(ret)
}

export function start() {
  wasm.start()
}

/**
 * Entry point invoked by JavaScript in a worker.
 * @param {number} ptr
 */
export function task_worker_entry_point(ptr) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    wasm.task_worker_entry_point(retptr, ptr)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    if (r1) {
      throw takeObject(r0)
    }
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Validate a BIP-39 mnemonic phrase.
 *
 * # Arguments
 *
 * * `phrase` - The mnemonic phrase to validate
 *
 * # Returns
 *
 * Returns Ok(()) if valid, or an error if invalid
 *
 * # Example
 *
 * ```javascript
 * try {
 *     validate_mnemonic("abandon abandon abandon ... art");
 *     console.log("Valid mnemonic");
 * } catch (e) {
 *     console.error("Invalid mnemonic:", e);
 * }
 * ```
 * @param {string} phrase
 */
export function validate_mnemonic(phrase) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    const ptr0 = passStringToWasm0(phrase, wasm.__wbindgen_export, wasm.__wbindgen_export2)
    const len0 = WASM_VECTOR_LEN
    wasm.validate_mnemonic(retptr, ptr0, len0)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    if (r1) {
      throw takeObject(r0)
    }
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

export class wbg_rayon_PoolBuilder {
  static __wrap(ptr) {
    const obj = Object.create(wbg_rayon_PoolBuilder.prototype)
    obj.__wbg_ptr = ptr
    wbg_rayon_PoolBuilderFinalization.register(obj, obj.__wbg_ptr, obj)
    return obj
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    wbg_rayon_PoolBuilderFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 0)
  }
  build() {
    wasm.wbg_rayon_poolbuilder_build(this.__wbg_ptr)
  }
  /**
   * @returns {number}
   */
  numThreads() {
    const ret = wasm.wbg_rayon_poolbuilder_numThreads(this.__wbg_ptr)
    return ret >>> 0
  }
  /**
   * @returns {number}
   */
  receiver() {
    const ret = wasm.wbg_rayon_poolbuilder_receiver(this.__wbg_ptr)
    return ret >>> 0
  }
}
if (Symbol.dispose)
  wbg_rayon_PoolBuilder.prototype[Symbol.dispose] = wbg_rayon_PoolBuilder.prototype.free

/**
 * @param {number} receiver
 */
export function wbg_rayon_start_worker(receiver) {
  wasm.wbg_rayon_start_worker(receiver)
}
function __wbg_get_imports(memory) {
  const import0 = {
    __proto__: null,
    __wbg_Error_ef53bc310eb298a0: function (arg0, arg1) {
      const ret = Error(getStringFromWasm0(arg0, arg1))
      return addHeapObject(ret)
    },
    __wbg_Number_6b506e6536831eaa: function (arg0) {
      const ret = Number(getObject(arg0))
      return ret
    },
    __wbg___wbindgen_bigint_get_as_i64_38130e98eecd467d: function (arg0, arg1) {
      const v = getObject(arg1)
      const ret = typeof v === 'bigint' ? v : undefined
      getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true)
    },
    __wbg___wbindgen_boolean_get_1a45e2c38d4d41b9: function (arg0) {
      const v = getObject(arg0)
      const ret = typeof v === 'boolean' ? v : undefined
      return isLikeNone(ret) ? 0xffffff : ret ? 1 : 0
    },
    __wbg___wbindgen_debug_string_0accd80f45e5faa2: function (arg0, arg1) {
      const ret = debugString(getObject(arg1))
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbg___wbindgen_in_70a403a56e771704: function (arg0, arg1) {
      const ret = getObject(arg0) in getObject(arg1)
      return ret
    },
    __wbg___wbindgen_is_bigint_6ffd6468a9bc44b9: function (arg0) {
      const ret = typeof getObject(arg0) === 'bigint'
      return ret
    },
    __wbg___wbindgen_is_function_754e9f305ff6029e: function (arg0) {
      const ret = typeof getObject(arg0) === 'function'
      return ret
    },
    __wbg___wbindgen_is_null_87c3bfe968c6a5ad: function (arg0) {
      const ret = getObject(arg0) === null
      return ret
    },
    __wbg___wbindgen_is_null_or_undefined_cf617b836541fad3: function (arg0) {
      const ret = getObject(arg0) == null
      return ret
    },
    __wbg___wbindgen_is_object_56732c2bc353f41d: function (arg0) {
      const val = getObject(arg0)
      const ret = typeof val === 'object' && val !== null
      return ret
    },
    __wbg___wbindgen_is_string_c236cabd84a4d769: function (arg0) {
      const ret = typeof getObject(arg0) === 'string'
      return ret
    },
    __wbg___wbindgen_is_undefined_67b456be8673d3d7: function (arg0) {
      const ret = getObject(arg0) === undefined
      return ret
    },
    __wbg___wbindgen_jsval_eq_1068e624fa87f6ab: function (arg0, arg1) {
      const ret = getObject(arg0) === getObject(arg1)
      return ret
    },
    __wbg___wbindgen_jsval_loose_eq_2c56564c75129511: function (arg0, arg1) {
      const ret = getObject(arg0) == getObject(arg1)
      return ret
    },
    __wbg___wbindgen_memory_fbc4c3e30b409f08: function () {
      const ret = wasm.memory
      return addHeapObject(ret)
    },
    __wbg___wbindgen_module_5dcc25d553a4424f: function () {
      const ret = wasmModule
      return addHeapObject(ret)
    },
    __wbg___wbindgen_number_get_9bb1761122181af2: function (arg0, arg1) {
      const obj = getObject(arg1)
      const ret = typeof obj === 'number' ? obj : undefined
      getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true)
    },
    __wbg___wbindgen_rethrow_c4d99b4b53265290: function (arg0) {
      throw takeObject(arg0)
    },
    __wbg___wbindgen_string_get_72bdf95d3ae505b1: function (arg0, arg1) {
      const obj = getObject(arg1)
      const ret = typeof obj === 'string' ? obj : undefined
      var ptr1 = isLikeNone(ret)
        ? 0
        : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      var len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbg___wbindgen_throw_1506f2235d1bdba0: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1))
    },
    __wbg__wbg_cb_unref_61db23ac97f16c31: function (arg0) {
      getObject(arg0)._wbg_cb_unref()
    },
    __wbg_abort_2ec46222bf378517: function (arg0) {
      getObject(arg0).abort()
    },
    __wbg_abort_b29d719932441c95: function (arg0, arg1) {
      getObject(arg0).abort(getObject(arg1))
    },
    __wbg_append_e1746995edcb0170: function () {
      return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        getObject(arg0).append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4))
      }, arguments)
    },
    __wbg_async_ed0edf9269e8f04a: function (arg0) {
      const ret = getObject(arg0).async
      return ret
    },
    __wbg_body_61a0827da5b6d2bc: function (arg0) {
      const ret = getObject(arg0).body
      return isLikeNone(ret) ? 0 : addHeapObject(ret)
    },
    __wbg_buffer_a1f116eb4fdb1531: function (arg0) {
      const ret = getObject(arg0).buffer
      return addHeapObject(ret)
    },
    __wbg_buffer_d370c8cae5692933: function (arg0) {
      const ret = getObject(arg0).buffer
      return addHeapObject(ret)
    },
    __wbg_byobRequest_2c89fb4ab478fa09: function (arg0) {
      const ret = getObject(arg0).byobRequest
      return isLikeNone(ret) ? 0 : addHeapObject(ret)
    },
    __wbg_byteLength_2c6dc3b4b85d3547: function (arg0) {
      const ret = getObject(arg0).byteLength
      return ret
    },
    __wbg_byteOffset_349aa9bf0a183eca: function (arg0) {
      const ret = getObject(arg0).byteOffset
      return ret
    },
    __wbg_call_40e4174f169eaca7: function () {
      return handleError(function (arg0, arg1, arg2, arg3) {
        const ret = getObject(arg0).call(getObject(arg1), getObject(arg2), getObject(arg3))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_call_8a89609d89f6608a: function () {
      return handleError(function (arg0, arg1) {
        const ret = getObject(arg0).call(getObject(arg1))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_call_9c758de292015997: function () {
      return handleError(function (arg0, arg1, arg2) {
        const ret = getObject(arg0).call(getObject(arg1), getObject(arg2))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_cancel_3dedc1c2245a59d4: function (arg0) {
      const ret = getObject(arg0).cancel()
      return addHeapObject(ret)
    },
    __wbg_catch_17ae9c6dfb88ad8a: function (arg0, arg1) {
      const ret = getObject(arg0).catch(getObject(arg1))
      return addHeapObject(ret)
    },
    __wbg_clearTimeout_4ce8abcdd5386a8f: function (arg0) {
      const ret = clearTimeout(takeObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_close_4859304bbf0f8208: function () {
      return handleError(function (arg0) {
        getObject(arg0).close()
      }, arguments)
    },
    __wbg_close_6f12196fe155e8d2: function () {
      return handleError(function (arg0) {
        getObject(arg0).close()
      }, arguments)
    },
    __wbg_create_8d32ae11bf54585f: function (arg0) {
      const ret = Object.create(getObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_crypto_48300657fced39f9: function (arg0) {
      const ret = getObject(arg0).crypto
      return addHeapObject(ret)
    },
    __wbg_data_93740e25a9d5b212: function (arg0) {
      const ret = getObject(arg0).data
      return addHeapObject(ret)
    },
    __wbg_debug_6d96d354ecb8cdb3: function (arg0, arg1, arg2, arg3) {
      console.debug(getObject(arg0), getObject(arg1), getObject(arg2), getObject(arg3))
    },
    __wbg_debug_78b457f1effb3792: function (arg0) {
      console.debug(getObject(arg0))
    },
    __wbg_done_60cf307fcc680536: function (arg0) {
      const ret = getObject(arg0).done
      return ret
    },
    __wbg_enqueue_09035479e2081625: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).enqueue(getObject(arg1))
      }, arguments)
    },
    __wbg_entries_04b37a02507f1713: function (arg0) {
      const ret = Object.entries(getObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_error_78ff5b3a29b770e0: function (arg0) {
      console.error(getObject(arg0))
    },
    __wbg_error_7a86db108813a39f: function (arg0, arg1) {
      console.error(getStringFromWasm0(arg0, arg1))
    },
    __wbg_error_9ad1450feb5d541d: function (arg0, arg1, arg2, arg3) {
      console.error(getObject(arg0), getObject(arg1), getObject(arg2), getObject(arg3))
    },
    __wbg_error_a6fa202b58aa1cd3: function (arg0, arg1) {
      let deferred0_0
      let deferred0_1
      try {
        deferred0_0 = arg0
        deferred0_1 = arg1
        console.error(getStringFromWasm0(arg0, arg1))
      } finally {
        wasm.__wbindgen_export4(deferred0_0, deferred0_1, 1)
      }
    },
    __wbg_fetch_9cd66815bfb42f0c: function (arg0, arg1, arg2) {
      const ret = getObject(arg0).fetch(getObject(arg1), getObject(arg2))
      return addHeapObject(ret)
    },
    __wbg_fetch_b9ec7cc04e1ed641: function (arg0, arg1) {
      const ret = fetch(getObject(arg0), getObject(arg1))
      return addHeapObject(ret)
    },
    __wbg_getDate_3d2f964145b3449d: function (arg0) {
      const ret = getObject(arg0).getDate()
      return ret
    },
    __wbg_getDay_36952f7a4e4bf5c2: function (arg0) {
      const ret = getObject(arg0).getDay()
      return ret
    },
    __wbg_getFullYear_8b1ba9a648a4de7f: function (arg0) {
      const ret = getObject(arg0).getFullYear()
      return ret
    },
    __wbg_getHours_91ac680ae491b8ea: function (arg0) {
      const ret = getObject(arg0).getHours()
      return ret
    },
    __wbg_getMinutes_c1c2573becc0c7b5: function (arg0) {
      const ret = getObject(arg0).getMinutes()
      return ret
    },
    __wbg_getMonth_44bdf67c99f2ed79: function (arg0) {
      const ret = getObject(arg0).getMonth()
      return ret
    },
    __wbg_getRandomValues_127d43fea0fcc894: function () {
      return handleError(function (arg0) {
        globalThis.crypto.getRandomValues(getObject(arg0))
      }, arguments)
    },
    __wbg_getRandomValues_263d0aa5464054ee: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).getRandomValues(getObject(arg1))
      }, arguments)
    },
    __wbg_getRandomValues_7d0ae0505919766f: function () {
      return handleError(function (arg0) {
        globalThis.crypto.getRandomValues(getObject(arg0))
      }, arguments)
    },
    __wbg_getReader_b4b1868fbca77dbe: function () {
      return handleError(function (arg0) {
        const ret = getObject(arg0).getReader()
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_getSeconds_2716239745eecd0a: function (arg0) {
      const ret = getObject(arg0).getSeconds()
      return ret
    },
    __wbg_getTime_00b3f7db575e4ef5: function (arg0) {
      const ret = getObject(arg0).getTime()
      return ret
    },
    __wbg_getTimezoneOffset_08e2892156231088: function (arg0) {
      const ret = getObject(arg0).getTimezoneOffset()
      return ret
    },
    __wbg_get_0d06c4d815368a19: function () {
      return handleError(function (arg0, arg1, arg2, arg3) {
        const ret = getObject(arg1).get(getStringFromWasm0(arg2, arg3))
        var ptr1 = isLikeNone(ret)
          ? 0
          : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
        var len1 = WASM_VECTOR_LEN
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
      }, arguments)
    },
    __wbg_get_1f8f054ddbaa7db2: function () {
      return handleError(function (arg0, arg1) {
        const ret = Reflect.get(getObject(arg0), getObject(arg1))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_get_2b48c7d0d006a781: function (arg0, arg1) {
      const ret = getObject(arg0)[arg1 >>> 0]
      return addHeapObject(ret)
    },
    __wbg_get_de6a0f7d4d18a304: function () {
      return handleError(function (arg0, arg1) {
        const ret = Reflect.get(getObject(arg0), getObject(arg1))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_get_done_ea9eb315d4ec1e81: function (arg0) {
      const ret = getObject(arg0).done
      return isLikeNone(ret) ? 0xffffff : ret ? 1 : 0
    },
    __wbg_get_unchecked_33f6e5c9e2f2d6b2: function (arg0, arg1) {
      const ret = getObject(arg0)[arg1 >>> 0]
      return addHeapObject(ret)
    },
    __wbg_get_value_c68fe2e1a76c69ca: function (arg0) {
      const ret = getObject(arg0).value
      return addHeapObject(ret)
    },
    __wbg_get_with_ref_key_6412cf3094599694: function (arg0, arg1) {
      const ret = getObject(arg0)[getObject(arg1)]
      return addHeapObject(ret)
    },
    __wbg_has_73740b27f436fed3: function () {
      return handleError(function (arg0, arg1) {
        const ret = Reflect.has(getObject(arg0), getObject(arg1))
        return ret
      }, arguments)
    },
    __wbg_headers_0feb63d2d374b44a: function (arg0) {
      const ret = getObject(arg0).headers
      return addHeapObject(ret)
    },
    __wbg_info_5cfb3f6c22c53cf9: function (arg0, arg1, arg2, arg3) {
      console.info(getObject(arg0), getObject(arg1), getObject(arg2), getObject(arg3))
    },
    __wbg_info_af7f45292ba9b0ea: function (arg0) {
      console.info(getObject(arg0))
    },
    __wbg_instanceof_ArrayBuffer_8f49811467741499: function (arg0) {
      let result
      try {
        result = getObject(arg0) instanceof ArrayBuffer
      } catch (_) {
        result = false
      }
      const ret = result
      return ret
    },
    __wbg_instanceof_Map_9fc06d9a951bcee6: function (arg0) {
      let result
      try {
        result = getObject(arg0) instanceof Map
      } catch (_) {
        result = false
      }
      const ret = result
      return ret
    },
    __wbg_instanceof_Promise_d0db99486956c8e8: function (arg0) {
      let result
      try {
        result = getObject(arg0) instanceof Promise
      } catch (_) {
        result = false
      }
      const ret = result
      return ret
    },
    __wbg_instanceof_Response_cb984bd66d7bd408: function (arg0) {
      let result
      try {
        result = getObject(arg0) instanceof Response
      } catch (_) {
        result = false
      }
      const ret = result
      return ret
    },
    __wbg_instanceof_Uint8Array_86f30649f63ef9c2: function (arg0) {
      let result
      try {
        result = getObject(arg0) instanceof Uint8Array
      } catch (_) {
        result = false
      }
      const ret = result
      return ret
    },
    __wbg_instanceof_Window_e093be59ee9a8e14: function (arg0) {
      let result
      try {
        result = getObject(arg0) instanceof Window
      } catch (_) {
        result = false
      }
      const ret = result
      return ret
    },
    __wbg_isArray_67c2c9c4313f4448: function (arg0) {
      const ret = Array.isArray(getObject(arg0))
      return ret
    },
    __wbg_isSafeInteger_66acec27e09e99a7: function (arg0) {
      const ret = Number.isSafeInteger(getObject(arg0))
      return ret
    },
    __wbg_iterator_8732428d309e270e: function () {
      const ret = Symbol.iterator
      return addHeapObject(ret)
    },
    __wbg_length_4a591ecaa01354d9: function (arg0) {
      const ret = getObject(arg0).length
      return ret
    },
    __wbg_length_66f1a4b2e9026940: function (arg0) {
      const ret = getObject(arg0).length
      return ret
    },
    __wbg_mark_310e9a031ccc84ff: function () {
      return handleError(function (arg0, arg1, arg2) {
        getObject(arg0).mark(getStringFromWasm0(arg1, arg2))
      }, arguments)
    },
    __wbg_mark_742962d66a858cc5: function () {
      return handleError(function (arg0, arg1, arg2, arg3) {
        getObject(arg0).mark(getStringFromWasm0(arg1, arg2), getObject(arg3))
      }, arguments)
    },
    __wbg_measure_54743279e77e77bb: function () {
      return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
        getObject(arg0).measure(
          getStringFromWasm0(arg1, arg2),
          getStringFromWasm0(arg3, arg4),
          getStringFromWasm0(arg5, arg6)
        )
      }, arguments)
    },
    __wbg_measure_cd1f7667d5f5517d: function () {
      return handleError(function (arg0, arg1, arg2, arg3) {
        getObject(arg0).measure(getStringFromWasm0(arg1, arg2), getObject(arg3))
      }, arguments)
    },
    __wbg_msCrypto_8c6d45a75ef1d3da: function (arg0) {
      const ret = getObject(arg0).msCrypto
      return addHeapObject(ret)
    },
    __wbg_new_0_445c13a750296eb6: function () {
      const ret = new Date()
      return addHeapObject(ret)
    },
    __wbg_new_0d09705104e164af: function () {
      return handleError(function () {
        const ret = new AbortController()
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_new_227d7c05414eb861: function () {
      const ret = new Error()
      return addHeapObject(ret)
    },
    __wbg_new_50bb5ebeecef71a8: function (arg0, arg1) {
      const ret = new Error(getStringFromWasm0(arg0, arg1))
      return addHeapObject(ret)
    },
    __wbg_new_578aeef4b6b94378: function (arg0) {
      const ret = new Uint8Array(getObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_new_622fc80556be2e26: function () {
      const ret = new Map()
      return addHeapObject(ret)
    },
    __wbg_new_6d75fd236f920a62: function (arg0) {
      const ret = new Date(getObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_new_b682b81e8eaaf027: function (arg0, arg1) {
      try {
        var state0 = { a: arg0, b: arg1 }
        var cb0 = (arg0, arg1) => {
          const a = state0.a
          state0.a = 0
          try {
            return __wasm_bindgen_func_elem_16724(a, state0.b, arg0, arg1)
          } finally {
            state0.a = a
          }
        }
        const ret = new Promise(cb0)
        return addHeapObject(ret)
      } finally {
        state0.a = 0
      }
    },
    __wbg_new_ce1ab61c1c2b300d: function () {
      const ret = new Object()
      return addHeapObject(ret)
    },
    __wbg_new_d90091b82fdf5b91: function () {
      const ret = new Array()
      return addHeapObject(ret)
    },
    __wbg_new_dc32d91df76232c8: function (arg0) {
      const ret = new Int32Array(getObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_new_e436d06bc8e77460: function () {
      return handleError(function () {
        const ret = new Headers()
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_new_from_slice_18fa1f71286d66b8: function (arg0, arg1) {
      const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1))
      return addHeapObject(ret)
    },
    __wbg_new_typed_bf31d18f92484486: function (arg0, arg1) {
      try {
        var state0 = { a: arg0, b: arg1 }
        var cb0 = (arg0, arg1) => {
          const a = state0.a
          state0.a = 0
          try {
            return __wasm_bindgen_func_elem_16724(a, state0.b, arg0, arg1)
          } finally {
            state0.a = a
          }
        }
        const ret = new Promise(cb0)
        return addHeapObject(ret)
      } finally {
        state0.a = 0
      }
    },
    __wbg_new_with_byte_offset_and_length_d836f26d916dd9ad: function (arg0, arg1, arg2) {
      const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0)
      return addHeapObject(ret)
    },
    __wbg_new_with_length_36a4998e27b014c5: function (arg0) {
      const ret = new Uint8Array(arg0 >>> 0)
      return addHeapObject(ret)
    },
    __wbg_new_with_length_b4a87ccced374381: function (arg0) {
      const ret = new Float64Array(arg0 >>> 0)
      return addHeapObject(ret)
    },
    __wbg_new_with_str_and_init_bcd02b79a793d27f: function () {
      return handleError(function (arg0, arg1, arg2) {
        const ret = new Request(getStringFromWasm0(arg0, arg1), getObject(arg2))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_new_with_year_month_day_1c037825a6927e19: function (arg0, arg1, arg2) {
      const ret = new Date(arg0 >>> 0, arg1, arg2)
      return addHeapObject(ret)
    },
    __wbg_new_worker_227309bcfae51cd3: function (arg0, arg1) {
      const ret = new Worker(getStringFromWasm0(arg0, arg1))
      return addHeapObject(ret)
    },
    __wbg_next_9e03acdf51c4960d: function (arg0) {
      const ret = getObject(arg0).next
      return addHeapObject(ret)
    },
    __wbg_next_eb8ca7351fa27906: function () {
      return handleError(function (arg0) {
        const ret = getObject(arg0).next()
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_node_95beb7570492fd97: function (arg0) {
      const ret = getObject(arg0).node
      return addHeapObject(ret)
    },
    __wbg_now_190933fa139cc119: function () {
      const ret = Date.now()
      return ret
    },
    __wbg_of_5d9c1c77975668d1: function (arg0, arg1, arg2) {
      const ret = Array.of(getObject(arg0), getObject(arg1), getObject(arg2))
      return addHeapObject(ret)
    },
    __wbg_ownKeys_0587b8fe286a40e6: function () {
      return handleError(function (arg0) {
        const ret = Reflect.ownKeys(getObject(arg0))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_paymentrequest_new: function (arg0) {
      const ret = PaymentRequest.__wrap(arg0)
      return addHeapObject(ret)
    },
    __wbg_paymentrequest_unwrap: function (arg0) {
      const ret = PaymentRequest.__unwrap(getObject(arg0))
      return ret
    },
    __wbg_pczt_new: function (arg0) {
      const ret = Pczt.__wrap(arg0)
      return addHeapObject(ret)
    },
    __wbg_performance_757310249566272b: function () {
      const ret = globalThis.performance
      return addHeapObject(ret)
    },
    __wbg_postMessage_c28ba544836193c8: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).postMessage(getObject(arg1))
      }, arguments)
    },
    __wbg_postMessage_e8c4bd80b9d48c72: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).postMessage(getObject(arg1))
      }, arguments)
    },
    __wbg_process_b2fea42461d03994: function (arg0) {
      const ret = getObject(arg0).process
      return addHeapObject(ret)
    },
    __wbg_prototypesetcall_3249fc62a0fafa30: function (arg0, arg1, arg2) {
      Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2))
    },
    __wbg_push_a6822215aa43e71c: function (arg0, arg1) {
      const ret = getObject(arg0).push(getObject(arg1))
      return ret
    },
    __wbg_queueMicrotask_35c611f4a14830b2: function (arg0) {
      queueMicrotask(getObject(arg0))
    },
    __wbg_queueMicrotask_404ed0a58e0b63cc: function (arg0) {
      const ret = getObject(arg0).queueMicrotask
      return addHeapObject(ret)
    },
    __wbg_randomFillSync_ca9f178fb14c88cb: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).randomFillSync(takeObject(arg1))
      }, arguments)
    },
    __wbg_random_33cfffca5c784d5e: function () {
      const ret = Math.random()
      return ret
    },
    __wbg_read_282e152a24fd0856: function (arg0) {
      const ret = getObject(arg0).read()
      return addHeapObject(ret)
    },
    __wbg_releaseLock_cd76770b7f82a961: function (arg0) {
      getObject(arg0).releaseLock()
    },
    __wbg_require_7a9419e39d796c95: function () {
      return handleError(function () {
        const ret = module.require
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_resolve_25a7e548d5881dca: function (arg0) {
      const ret = Promise.resolve(getObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_respond_33b6f330b6d299fd: function () {
      return handleError(function (arg0, arg1) {
        getObject(arg0).respond(arg1 >>> 0)
      }, arguments)
    },
    __wbg_setTimeout_3f4119f26240bd79: function (arg0, arg1) {
      const ret = setTimeout(getObject(arg0), arg1)
      return addHeapObject(ret)
    },
    __wbg_setTimeout_70b6d79423f8e1db: function (arg0, arg1) {
      setTimeout(getObject(arg0), arg1)
    },
    __wbg_set_25ef40a9aeff260d: function () {
      return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        getObject(arg0).set(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4))
      }, arguments)
    },
    __wbg_set_29c99a8aac1c01e5: function (arg0, arg1, arg2) {
      getObject(arg0).set(getArrayU8FromWasm0(arg1, arg2))
    },
    __wbg_set_52b1e1eb5bed906a: function (arg0, arg1, arg2) {
      const ret = getObject(arg0).set(getObject(arg1), getObject(arg2))
      return addHeapObject(ret)
    },
    __wbg_set_6be42768c690e380: function (arg0, arg1, arg2) {
      getObject(arg0)[takeObject(arg1)] = takeObject(arg2)
    },
    __wbg_set_6e30c9374c26414c: function () {
      return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(getObject(arg0), getObject(arg1), getObject(arg2))
        return ret
      }, arguments)
    },
    __wbg_set_body_36614c7e61546809: function (arg0, arg1) {
      getObject(arg0).body = getObject(arg1)
    },
    __wbg_set_cache_488ea16c11cbf20d: function (arg0, arg1) {
      getObject(arg0).cache = __wbindgen_enum_RequestCache[arg1]
    },
    __wbg_set_credentials_fa9c491a27c4bdf0: function (arg0, arg1) {
      getObject(arg0).credentials = __wbindgen_enum_RequestCredentials[arg1]
    },
    __wbg_set_dca99999bba88a9a: function (arg0, arg1, arg2) {
      getObject(arg0)[arg1 >>> 0] = takeObject(arg2)
    },
    __wbg_set_headers_7c1e39ece7826bec: function (arg0, arg1) {
      getObject(arg0).headers = getObject(arg1)
    },
    __wbg_set_index_c69336ea758c0507: function (arg0, arg1, arg2) {
      getObject(arg0)[arg1 >>> 0] = arg2
    },
    __wbg_set_integrity_30981c8c202903f4: function (arg0, arg1, arg2) {
      getObject(arg0).integrity = getStringFromWasm0(arg1, arg2)
    },
    __wbg_set_method_7a6811dec7a4feff: function (arg0, arg1, arg2) {
      getObject(arg0).method = getStringFromWasm0(arg1, arg2)
    },
    __wbg_set_mode_c90e3667002857d4: function (arg0, arg1) {
      getObject(arg0).mode = __wbindgen_enum_RequestMode[arg1]
    },
    __wbg_set_name_3c3fc49c8f747e56: function (arg0, arg1, arg2) {
      getObject(arg0).name = getStringFromWasm0(arg1, arg2)
    },
    __wbg_set_onmessage_ad00166b07fad0be: function (arg0, arg1) {
      getObject(arg0).onmessage = getObject(arg1)
    },
    __wbg_set_redirect_55da4f54e5bdbb0c: function (arg0, arg1) {
      getObject(arg0).redirect = __wbindgen_enum_RequestRedirect[arg1]
    },
    __wbg_set_referrer_d2c1743cb1404fd3: function (arg0, arg1, arg2) {
      getObject(arg0).referrer = getStringFromWasm0(arg1, arg2)
    },
    __wbg_set_referrer_policy_0ad167d0b0f0713e: function (arg0, arg1) {
      getObject(arg0).referrerPolicy = __wbindgen_enum_ReferrerPolicy[arg1]
    },
    __wbg_set_signal_d9da62b3f215c821: function (arg0, arg1) {
      getObject(arg0).signal = getObject(arg1)
    },
    __wbg_signal_e03304a84df9ed09: function (arg0) {
      const ret = getObject(arg0).signal
      return addHeapObject(ret)
    },
    __wbg_stack_3b0d974bbf31e44f: function (arg0, arg1) {
      const ret = getObject(arg1).stack
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbg_startWorkers_8b582d57e92bd2d4: function (arg0, arg1, arg2) {
      const ret = startWorkers(
        takeObject(arg0),
        takeObject(arg1),
        wbg_rayon_PoolBuilder.__wrap(arg2)
      )
      return addHeapObject(ret)
    },
    __wbg_static_accessor_GLOBAL_9d53f2689e622ca1: function () {
      const ret = typeof global === 'undefined' ? null : global
      return isLikeNone(ret) ? 0 : addHeapObject(ret)
    },
    __wbg_static_accessor_GLOBAL_THIS_a1a35cec07001a8a: function () {
      const ret = typeof globalThis === 'undefined' ? null : globalThis
      return isLikeNone(ret) ? 0 : addHeapObject(ret)
    },
    __wbg_static_accessor_SELF_4c59f6c7ea29a144: function () {
      const ret = typeof self === 'undefined' ? null : self
      return isLikeNone(ret) ? 0 : addHeapObject(ret)
    },
    __wbg_static_accessor_WINDOW_e70ae9f2eb052253: function () {
      const ret = typeof window === 'undefined' ? null : window
      return isLikeNone(ret) ? 0 : addHeapObject(ret)
    },
    __wbg_status_00549d55b78d949e: function (arg0) {
      const ret = getObject(arg0).status
      return ret
    },
    __wbg_subarray_4aa221f6a4f5ab22: function (arg0, arg1, arg2) {
      const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0)
      return addHeapObject(ret)
    },
    __wbg_then_18f476d590e58992: function (arg0, arg1, arg2) {
      const ret = getObject(arg0).then(getObject(arg1), getObject(arg2))
      return addHeapObject(ret)
    },
    __wbg_then_47213a40b6aeb86c: function (arg0, arg1) {
      const ret = getObject(arg0).then(getObject(arg1))
      return addHeapObject(ret)
    },
    __wbg_then_ac7b025999b52837: function (arg0, arg1) {
      const ret = getObject(arg0).then(getObject(arg1))
      return addHeapObject(ret)
    },
    __wbg_toString_1fcc5569307bd3f3: function (arg0) {
      const ret = getObject(arg0).toString()
      return addHeapObject(ret)
    },
    __wbg_value_2b11d753e2be3e57: function (arg0) {
      const ret = getObject(arg0).value
      return addHeapObject(ret)
    },
    __wbg_value_f3625092ee4b37f4: function (arg0) {
      const ret = getObject(arg0).value
      return addHeapObject(ret)
    },
    __wbg_versions_215a3ab1c9d5745a: function (arg0) {
      const ret = getObject(arg0).versions
      return addHeapObject(ret)
    },
    __wbg_view_d523e3b92648b62c: function (arg0) {
      const ret = getObject(arg0).view
      return isLikeNone(ret) ? 0 : addHeapObject(ret)
    },
    __wbg_waitAsync_bfb213899274180a: function (arg0, arg1, arg2) {
      const ret = Atomics.waitAsync(getObject(arg0), arg1 >>> 0, arg2)
      return addHeapObject(ret)
    },
    __wbg_waitAsync_fbc667ccb52b6fbf: function () {
      const ret = Atomics.waitAsync
      return addHeapObject(ret)
    },
    __wbg_walletsummary_new: function (arg0) {
      const ret = WalletSummary.__wrap(arg0)
      return addHeapObject(ret)
    },
    __wbg_warn_410c3261e3c6d686: function (arg0) {
      console.warn(getObject(arg0))
    },
    __wbg_warn_c49a7a9581bf8bea: function (arg0, arg1, arg2, arg3) {
      console.warn(getObject(arg0), getObject(arg1), getObject(arg2), getObject(arg3))
    },
    __wbindgen_cast_0000000000000001: function (arg0, arg1) {
      // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 4237, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
      const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_12601)
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000002: function (arg0, arg1) {
      // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 5453, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
      const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_16707)
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000003: function (arg0, arg1) {
      // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 5455, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
      const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_16709)
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000004: function (arg0, arg1) {
      // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [], shim_idx: 4208, ret: Unit, inner_ret: Some(Unit) }, mutable: true }) -> Externref`.
      const ret = makeMutClosure(arg0, arg1, __wasm_bindgen_func_elem_12524)
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000005: function (arg0) {
      // Cast intrinsic for `F64 -> Externref`.
      const ret = arg0
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000006: function (arg0) {
      // Cast intrinsic for `I64 -> Externref`.
      const ret = arg0
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000007: function (arg0, arg1) {
      // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
      const ret = getArrayU8FromWasm0(arg0, arg1)
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000008: function (arg0, arg1) {
      // Cast intrinsic for `Ref(String) -> Externref`.
      const ret = getStringFromWasm0(arg0, arg1)
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000009: function (arg0) {
      // Cast intrinsic for `U64 -> Externref`.
      const ret = BigInt.asUintN(64, arg0)
      return addHeapObject(ret)
    },
    __wbindgen_cast_000000000000000a: function (arg0, arg1) {
      var v0 = getArrayU8FromWasm0(arg0, arg1).slice()
      wasm.__wbindgen_export4(arg0, arg1 * 1, 1)
      // Cast intrinsic for `Vector(U8) -> Externref`.
      const ret = v0
      return addHeapObject(ret)
    },
    __wbindgen_link_e2b5a1199ad11c6b: function (arg0) {
      const val = `onmessage = function (ev) {
                let [ia, index, value] = ev.data;
                ia = new Int32Array(ia.buffer);
                let result = Atomics.wait(ia, index, value);
                postMessage(result);
            };
            `
      const ret =
        typeof URL.createObjectURL === 'undefined'
          ? 'data:application/javascript,' + encodeURIComponent(val)
          : URL.createObjectURL(new Blob([val], { type: 'text/javascript' }))
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbindgen_object_clone_ref: function (arg0) {
      const ret = getObject(arg0)
      return addHeapObject(ret)
    },
    __wbindgen_object_drop_ref: function (arg0) {
      takeObject(arg0)
    },
    memory: memory || new WebAssembly.Memory({ initial: 840, maximum: 65536, shared: true })
  }
  return {
    __proto__: null,
    './zcash_wallet_wasm_bg.js': import0
  }
}

function __wasm_bindgen_func_elem_12524(arg0, arg1) {
  wasm.__wasm_bindgen_func_elem_12524(arg0, arg1)
}

function __wasm_bindgen_func_elem_12601(arg0, arg1, arg2) {
  wasm.__wasm_bindgen_func_elem_12601(arg0, arg1, addHeapObject(arg2))
}

function __wasm_bindgen_func_elem_16709(arg0, arg1, arg2) {
  wasm.__wasm_bindgen_func_elem_16709(arg0, arg1, addHeapObject(arg2))
}

function __wasm_bindgen_func_elem_16707(arg0, arg1, arg2) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    wasm.__wasm_bindgen_func_elem_16707(retptr, arg0, arg1, addHeapObject(arg2))
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    if (r1) {
      throw takeObject(r0)
    }
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

function __wasm_bindgen_func_elem_16724(arg0, arg1, arg2, arg3) {
  wasm.__wasm_bindgen_func_elem_16724(arg0, arg1, addHeapObject(arg2), addHeapObject(arg3))
}

const __wbindgen_enum_ReadableStreamType = ['bytes']

const __wbindgen_enum_ReferrerPolicy = [
  '',
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'unsafe-url',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin'
]

const __wbindgen_enum_RequestCache = [
  'default',
  'no-store',
  'reload',
  'no-cache',
  'force-cache',
  'only-if-cached'
]

const __wbindgen_enum_RequestCredentials = ['omit', 'same-origin', 'include']

const __wbindgen_enum_RequestMode = ['same-origin', 'no-cors', 'cors', 'navigate']

const __wbindgen_enum_RequestRedirect = ['follow', 'error', 'manual']
const BlockRangeFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blockrange_free(ptr, 1))
const CanaryFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_canary_free(ptr, 1))
const CoordinatorFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_coordinator_free(ptr, 1))
const DepositFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_deposit_free(ptr, 1))
const DkgFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dkg_free(ptr, 1))
const Dkg1Finalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dkg1_free(ptr, 1))
const Dkg2Finalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dkg2_free(ptr, 1))
const Dkg3Finalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dkg3_free(ptr, 1))
const DkgRelayFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dkgrelay_free(ptr, 1))
const EnvelopeCodecFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_envelopecodec_free(ptr, 1))
const IntoUnderlyingByteSourceFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingbytesource_free(ptr, 1))
const IntoUnderlyingSinkFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsink_free(ptr, 1))
const IntoUnderlyingSourceFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_intounderlyingsource_free(ptr, 1))
const KeysetFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_keyset_free(ptr, 1))
const MessageSetFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_messageset_free(ptr, 1))
const NoiseXxFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_noisexx_free(ptr, 1))
const PaymentRequestFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_paymentrequest_free(ptr, 1))
const PcztFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pczt_free(ptr, 1))
const PcztToolsFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pczttools_free(ptr, 1))
const ProofGenerationKeyFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_proofgenerationkey_free(ptr, 1))
const ProposalFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_proposal_free(ptr, 1))
const RosterManifestFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rostermanifest_free(ptr, 1))
const SealedFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sealed_free(ptr, 1))
const SeedFingerprintFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_seedfingerprint_free(ptr, 1))
const SessionMarkerFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sessionmarker_free(ptr, 1))
const ShareBackupFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sharebackup_free(ptr, 1))
const SignerFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_signer_free(ptr, 1))
const TransactionRequestFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transactionrequest_free(ptr, 1))
const UnifiedFullViewingKeyFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unifiedfullviewingkey_free(ptr, 1))
const UnifiedSpendingKeyFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_unifiedspendingkey_free(ptr, 1))
const VerificationFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_verification_free(ptr, 1))
const WalletSummaryFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_walletsummary_free(ptr, 1))
const WebVotingSessionFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_webvotingsession_free(ptr, 1))
const WebWalletFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_webwallet_free(ptr, 1))
const wbg_rayon_PoolBuilderFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wbg_rayon_poolbuilder_free(ptr, 1))

function addHeapObject(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1)
  const idx = heap_next
  heap_next = heap[idx]

  heap[idx] = obj
  return idx
}

function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`)
  }
}

const CLOSURE_DTORS =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_export5(state.a, state.b))

function debugString(val) {
  // primitive types
  const type = typeof val
  if (type == 'number' || type == 'boolean' || val == null) {
    return `${val}`
  }
  if (type == 'string') {
    return `"${val}"`
  }
  if (type == 'symbol') {
    const description = val.description
    if (description == null) {
      return 'Symbol'
    } else {
      return `Symbol(${description})`
    }
  }
  if (type == 'function') {
    const name = val.name
    if (typeof name == 'string' && name.length > 0) {
      return `Function(${name})`
    } else {
      return 'Function'
    }
  }
  // objects
  if (Array.isArray(val)) {
    const length = val.length
    let debug = '['
    if (length > 0) {
      debug += debugString(val[0])
    }
    for (let i = 1; i < length; i++) {
      debug += ', ' + debugString(val[i])
    }
    debug += ']'
    return debug
  }
  // Test for built-in
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val))
  let className
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1]
  } else {
    // Failed to match the standard '[object ClassName]'
    return toString.call(val)
  }
  if (className == 'Object') {
    // we're a user defined class or Object
    // JSON.stringify avoids problems with cycles, and is generally much
    // easier than looping through ownProperties of `val`.
    try {
      return 'Object(' + JSON.stringify(val) + ')'
    } catch (_) {
      return 'Object'
    }
  }
  // errors
  if (val instanceof Error) {
    return `${val.name}: ${val.message}\n${val.stack}`
  }
  // TODO we could test for more things here, like `Set`s and `Map`s.
  return className
}

function dropObject(idx) {
  if (idx < 1028) return
  heap[idx] = heap_next
  heap_next = idx
}

function getArrayJsValueFromWasm0(ptr, len) {
  ptr = ptr >>> 0
  const mem = getDataViewMemory0()
  const result = []
  for (let i = ptr; i < ptr + 4 * len; i += 4) {
    result.push(takeObject(mem.getUint32(i, true)))
  }
  return result
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len)
}

let cachedDataViewMemory0 = null
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer)
  }
  return cachedDataViewMemory0
}

function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len)
}

let cachedUint8ArrayMemory0 = null
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.buffer !== wasm.memory.buffer) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer)
  }
  return cachedUint8ArrayMemory0
}

function getObject(idx) {
  return heap[idx]
}

function handleError(f, args) {
  try {
    return f.apply(this, args)
  } catch (e) {
    wasm.__wbindgen_export3(addHeapObject(e))
  }
}

let heap = new Array(1024).fill(undefined)
heap.push(undefined, null, true, false)

let heap_next = heap.length

function isLikeNone(x) {
  return x === undefined || x === null
}

function makeMutClosure(arg0, arg1, f) {
  const state = { a: arg0, b: arg1, cnt: 1 }
  const real = (...args) => {
    // First up with a closure we increment the internal reference
    // count. This ensures that the Rust closure environment won't
    // be deallocated while we're invoking it.
    state.cnt++
    const a = state.a
    state.a = 0
    try {
      return f(a, state.b, ...args)
    } finally {
      state.a = a
      real._wbg_cb_unref()
    }
  }
  real._wbg_cb_unref = () => {
    if (--state.cnt === 0) {
      wasm.__wbindgen_export5(state.a, state.b)
      state.a = 0
      CLOSURE_DTORS.unregister(state)
    }
  }
  CLOSURE_DTORS.register(real, state, state)
  return real
}

function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0
  getUint8ArrayMemory0().set(arg, ptr / 1)
  WASM_VECTOR_LEN = arg.length
  return ptr
}

function passArrayJsValueToWasm0(array, malloc) {
  const ptr = malloc(array.length * 4, 4) >>> 0
  const mem = getDataViewMemory0()
  for (let i = 0; i < array.length; i++) {
    mem.setUint32(ptr + 4 * i, addHeapObject(array[i]), true)
  }
  WASM_VECTOR_LEN = array.length
  return ptr
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg)
    const ptr = malloc(buf.length, 1) >>> 0
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf)
    WASM_VECTOR_LEN = buf.length
    return ptr
  }

  let len = arg.length
  let ptr = malloc(len, 1) >>> 0

  const mem = getUint8ArrayMemory0()

  let offset = 0

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset)
    if (code > 0x7f) break
    mem[ptr + offset] = code
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset)
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len)
    const ret = cachedTextEncoder.encodeInto(arg, view)

    offset += ret.written
    ptr = realloc(ptr, len, offset, 1) >>> 0
  }

  WASM_VECTOR_LEN = offset
  return ptr
}

function takeObject(idx) {
  const ret = getObject(idx)
  dropObject(idx)
  return ret
}

let cachedTextDecoder =
  typeof TextDecoder !== 'undefined'
    ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
    : undefined
if (cachedTextDecoder) cachedTextDecoder.decode()

const MAX_SAFARI_DECODE_BYTES = 2146435072
let numBytesDecoded = 0
function decodeText(ptr, len) {
  numBytesDecoded += len
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
    cachedTextDecoder.decode()
    numBytesDecoded = len
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().slice(ptr, ptr + len))
}

const cachedTextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined

if (cachedTextEncoder) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg)
    view.set(buf)
    return {
      read: arg.length,
      written: buf.length
    }
  }
}

let WASM_VECTOR_LEN = 0

let wasmModule, wasmInstance, wasm
function __wbg_finalize_init(instance, module, thread_stack_size) {
  wasmInstance = instance
  wasm = instance.exports
  wasmModule = module
  cachedDataViewMemory0 = null
  cachedUint8ArrayMemory0 = null
  if (
    typeof thread_stack_size !== 'undefined' &&
    (typeof thread_stack_size !== 'number' ||
      thread_stack_size === 0 ||
      thread_stack_size % 65536 !== 0)
  ) {
    throw new Error('invalid stack size')
  }

  wasm.__wbindgen_start(thread_stack_size)
  return wasm
}

async function __wbg_load(module, imports) {
  if (typeof Response === 'function' && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      try {
        return await WebAssembly.instantiateStreaming(module, imports)
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type)

        if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
          console.warn(
            '`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n',
            e
          )
        } else {
          throw e
        }
      }
    }

    const bytes = await module.arrayBuffer()
    return await WebAssembly.instantiate(bytes, imports)
  } else {
    const instance = await WebAssembly.instantiate(module, imports)

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module }
    } else {
      return instance
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case 'basic':
      case 'cors':
      case 'default':
        return true
    }
    return false
  }
}

function initSync(module, memory) {
  if (wasm !== undefined) return wasm

  let thread_stack_size
  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ;({ module, memory, thread_stack_size } = module)
    } else {
      console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
    }
  }

  const imports = __wbg_get_imports(memory)
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module)
  }
  const instance = new WebAssembly.Instance(module, imports)
  return __wbg_finalize_init(instance, module, thread_stack_size)
}

async function __wbg_init(module_or_path, memory) {
  if (wasm !== undefined) return wasm

  let thread_stack_size
  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ;({ module_or_path, memory, thread_stack_size } = module_or_path)
    } else {
      console.warn(
        'using deprecated parameters for the initialization function; pass a single object instead'
      )
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL('zcash_wallet_wasm_bg.wasm', import.meta.url)
  }
  const imports = __wbg_get_imports(memory)

  if (
    typeof module_or_path === 'string' ||
    (typeof Request === 'function' && module_or_path instanceof Request) ||
    (typeof URL === 'function' && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path)
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports)

  return __wbg_finalize_init(instance, module, thread_stack_size)
}

export { initSync, __wbg_init as default }
