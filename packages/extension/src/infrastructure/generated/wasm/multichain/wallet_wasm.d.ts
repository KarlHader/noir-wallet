/* tslint:disable */
/* eslint-disable */

export class WalletEngine {
    free(): void;
    [Symbol.dispose](): void;
    attachStarknetSignature(request_json: string): any;
    buildStarknetUnsignedDeployAccount(request_json: string): any;
    buildStarknetUnsignedInvoke(request_json: string): any;
    computeStarknetAccountAddress(request_json: string): any;
    confirmBitcoinMessage(session_id: number, request_id: number): any;
    confirmBitcoinPsbt(session_id: number, request_id: number): any;
    confirmDashCoinJoinSpend(session_id: number, request_id: number): any;
    confirmDashMessage(session_id: number, request_id: number): any;
    confirmDashPsbt(session_id: number, request_id: number): any;
    confirmEvmPersonalMessage(session_id: number, request_id: number): any;
    confirmEvmTransaction(session_id: number, request_id: number): any;
    confirmEvmTypedData(session_id: number, request_id: number): any;
    confirmNearMessage(session_id: number, request_id: number): any;
    confirmNearTransaction(session_id: number, request_id: number): any;
    confirmPearlMessage(session_id: number, request_id: number): any;
    confirmPearlPsbt(session_id: number, request_id: number): any;
    confirmQuantusCall(session_id: number, request_id: number): any;
    confirmSolanaMessage(session_id: number, request_id: number): any;
    confirmSolanaTransaction(session_id: number, request_id: number): any;
    confirmStarknetDeployAccount(session_id: number, request_id: number): any;
    confirmStarknetInvoke(session_id: number, request_id: number): any;
    confirmStarknetTypedData(session_id: number, request_id: number): any;
    confirmTronMessage(session_id: number, request_id: number): any;
    confirmTronTransaction(session_id: number, request_id: number): any;
    coreInfo(): any;
    createWallet(word_count: number, password: string, bip39_passphrase: string): any;
    deriveBitcoinAccount(session_id: number, chain_id: string, address_type: string, account_index: number, change: boolean, address_index: number): any;
    deriveBitcoinAccounts(session_id: number, chain_id: string, address_type: string, account_index: number, change: boolean, start_address_index: number, count: number): any;
    deriveDashAccount(session_id: number, chain_id: string, account_index: number, change: boolean, address_index: number): any;
    deriveDashAccounts(session_id: number, chain_id: string, account_index: number, change: boolean, start_address_index: number, count: number): any;
    deriveEvmAccount(session_id: number, chain_id: string, address_index: number): any;
    deriveNearAccount(session_id: number, chain_id: string, account_index: number): any;
    derivePeaAccount(session_id: number, request: string): any;
    derivePearlAccount(session_id: number, chain_id: string, account_index: number, change: boolean, address_index: number): any;
    derivePearlAccounts(session_id: number, chain_id: string, account_index: number, change: boolean, start_address_index: number, count: number): any;
    deriveQuantusAccount(session_id: number, chain_id: string, scheme: string, account_index: number, change: boolean, address_index: number): any;
    deriveQuantusAccounts(session_id: number, chain_id: string, scheme: string, account_index: number, change: boolean, start_address_index: number, count: number): any;
    deriveQuantusWormhole(session_id: number, chain_id: string, account_index: number, address_index: number): any;
    deriveSolanaAccount(session_id: number, chain_id: string, account_index: number): any;
    deriveStarknetAccount(session_id: number, chain_id: string, account_index: number, address_index: number, class_hash: string): any;
    deriveStarknetAccounts(session_id: number, chain_id: string, account_index: number, start_address_index: number, count: number, class_hash: string): any;
    deriveTronAccount(session_id: number, chain_id: string, address_index: number): any;
    exportPrivateKey(session_id: number, vault: any, password: string, request: any): any;
    getDashCoinJoinStatus(session_id: number): any;
    hashStarknetTypedData(request_json: string): any;
    importPrivateKey(request: any, password: string): any;
    importStarknetAccount(mnemonic: string, password: string, bip39_passphrase: string, address: string): any;
    importWallet(mnemonic: string, password: string, bip39_passphrase: string): any;
    loadDashCoinJoinState(session_id: number, request_json: string): any;
    lock(session_id: number): boolean;
    lockAll(): void;
    constructor();
    pollDashCoinJoin(session_id: number): any;
    prepareBitcoinMessage(session_id: number, request: any): any;
    prepareBitcoinPsbt(session_id: number, chain_id: string, address_type: string, account_index: number, psbt_base64: string): any;
    prepareDashCoinJoinSpend(session_id: number, request_json: string): any;
    prepareDashMessage(session_id: number, chain_id: string, account_index: number, change: boolean, address_index: number, message: Uint8Array): any;
    prepareDashPsbt(session_id: number, chain_id: string, account_index: number, psbt_base64: string): any;
    prepareEvmPersonalMessage(session_id: number, chain_id: string, address_index: number, message: Uint8Array): any;
    prepareEvmTransaction(session_id: number, chain_id: string, address_index: number, request: any): any;
    prepareEvmTypedData(session_id: number, chain_id: string, address_index: number, typed_data_json: string): any;
    prepareNearMessage(session_id: number, request: any): any;
    prepareNearTransaction(session_id: number, request: any): any;
    preparePeaEvmPersonalMessage(session_id: number, pea_request: string, message: Uint8Array): any;
    preparePeaEvmTransaction(session_id: number, pea_request: string, execution_chain_id: string, transaction: any): any;
    preparePeaEvmTypedData(session_id: number, pea_request: string, execution_chain_id: string, typed_data_json: string): any;
    preparePearlMessage(session_id: number, request: any): any;
    preparePearlPsbt(session_id: number, chain_id: string, account_index: number, psbt_base64: string): any;
    prepareQuantusCall(session_id: number, request: any): any;
    prepareQuantusTransfer(session_id: number, request: any): any;
    prepareSolanaMessage(session_id: number, chain_id: string, account_index: number, message: Uint8Array): any;
    prepareSolanaTransaction(session_id: number, chain_id: string, account_index: number, transaction_base64: string): any;
    prepareStarknetDeployAccount(session_id: number, request_json: string): any;
    prepareStarknetInvoke(session_id: number, request_json: string): any;
    prepareStarknetTypedData(session_id: number, request_json: string): any;
    prepareTronMessage(session_id: number, chain_id: string, address_index: number, message: Uint8Array): any;
    prepareTronTransaction(session_id: number, request: any): any;
    processDashCoinJoinEvent(session_id: number, event_json: string): any;
    registerQuantusNetwork(chain_id: string, genesis_hash: string): void;
    rejectSigningRequest(session_id: number, request_id: number): boolean;
    requestDashCoinJoinFundingAddresses(session_id: number, request_json: string): any;
    sessionInfo(session_id: number): any;
    startDashCoinJoin(session_id: number, config_json: string): any;
    stopDashCoinJoin(session_id: number): any;
    unlock(vault: any, password: string): any;
    unlockDashCoinJoin(vault: any, password: string, request_json: string): any;
    verifyBitcoinMessage(chain_id: string, address: string, message: Uint8Array, signature: string): boolean;
    verifyDashMessage(chain_id: string, address: string, message: Uint8Array, signature_base64: string): boolean;
    verifyNearMessage(request: any): any;
    verifyPearlMessage(chain_id: string, address: string, message: Uint8Array, signature: string): boolean;
    verifySolanaMessage(chain_id: string, address: string, message: Uint8Array, signature: string): boolean;
    verifyStarknetTypedData(request_json: string): any;
    verifyTronMessage(chain_id: string, address: string, message: Uint8Array, signature: string): boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_walletengine_free: (a: number, b: number) => void;
    readonly walletengine_attachStarknetSignature: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_buildStarknetUnsignedDeployAccount: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_buildStarknetUnsignedInvoke: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_computeStarknetAccountAddress: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmBitcoinMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmBitcoinPsbt: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmDashCoinJoinSpend: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmDashMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmDashPsbt: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmEvmPersonalMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmEvmTransaction: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmEvmTypedData: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmNearMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmNearTransaction: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmPearlMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmPearlPsbt: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmQuantusCall: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmSolanaMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmSolanaTransaction: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmStarknetDeployAccount: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmStarknetInvoke: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmStarknetTypedData: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmTronMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_confirmTronTransaction: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_coreInfo: (a: number, b: number) => void;
    readonly walletengine_createWallet: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly walletengine_deriveBitcoinAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_deriveBitcoinAccounts: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly walletengine_deriveDashAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_deriveDashAccounts: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly walletengine_deriveEvmAccount: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly walletengine_deriveNearAccount: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly walletengine_derivePeaAccount: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_derivePearlAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_derivePearlAccounts: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly walletengine_deriveQuantusAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_deriveQuantusAccounts: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly walletengine_deriveQuantusWormhole: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly walletengine_deriveSolanaAccount: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly walletengine_deriveStarknetAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly walletengine_deriveStarknetAccounts: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_deriveTronAccount: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly walletengine_exportPrivateKey: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly walletengine_getDashCoinJoinStatus: (a: number, b: number, c: number) => void;
    readonly walletengine_hashStarknetTypedData: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_importPrivateKey: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_importStarknetAccount: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_importWallet: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_loadDashCoinJoinState: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_lock: (a: number, b: number) => number;
    readonly walletengine_lockAll: (a: number) => void;
    readonly walletengine_new: () => number;
    readonly walletengine_pollDashCoinJoin: (a: number, b: number, c: number) => void;
    readonly walletengine_prepareBitcoinMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_prepareBitcoinPsbt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_prepareDashCoinJoinSpend: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_prepareDashMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_prepareDashPsbt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_prepareEvmPersonalMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_prepareEvmTransaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly walletengine_prepareEvmTypedData: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_prepareNearMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_prepareNearTransaction: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_preparePeaEvmPersonalMessage: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly walletengine_preparePeaEvmTransaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly walletengine_preparePeaEvmTypedData: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_preparePearlMessage: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_preparePearlPsbt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_prepareQuantusCall: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_prepareQuantusTransfer: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_prepareSolanaMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_prepareSolanaTransaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_prepareStarknetDeployAccount: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_prepareStarknetInvoke: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_prepareStarknetTypedData: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_prepareTronMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly walletengine_prepareTronTransaction: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_processDashCoinJoinEvent: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_registerQuantusNetwork: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly walletengine_rejectSigningRequest: (a: number, b: number, c: number) => number;
    readonly walletengine_requestDashCoinJoinFundingAddresses: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_sessionInfo: (a: number, b: number, c: number) => void;
    readonly walletengine_startDashCoinJoin: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_stopDashCoinJoin: (a: number, b: number, c: number) => void;
    readonly walletengine_unlock: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly walletengine_unlockDashCoinJoin: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly walletengine_verifyBitcoinMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_verifyDashMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_verifyNearMessage: (a: number, b: number, c: number) => void;
    readonly walletengine_verifyPearlMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_verifySolanaMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly walletengine_verifyStarknetTypedData: (a: number, b: number, c: number, d: number) => void;
    readonly walletengine_verifyTronMessage: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
