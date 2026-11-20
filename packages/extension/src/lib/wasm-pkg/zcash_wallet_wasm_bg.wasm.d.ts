/* tslint:disable */
/* eslint-disable */
export const __wbg_blockrange_free: (a: number, b: number) => void
export const __wbg_get_blockrange_0: (a: number) => number
export const __wbg_get_blockrange_1: (a: number) => number
export const __wbg_get_walletsummary_chain_tip_height: (a: number) => number
export const __wbg_get_walletsummary_fully_scanned_height: (a: number) => number
export const __wbg_get_walletsummary_next_ironwood_subtree_index: (a: number) => bigint
export const __wbg_get_walletsummary_next_orchard_subtree_index: (a: number) => bigint
export const __wbg_get_walletsummary_next_sapling_subtree_index: (a: number) => bigint
export const __wbg_paymentrequest_free: (a: number, b: number) => void
export const __wbg_pczt_free: (a: number, b: number) => void
export const __wbg_proofgenerationkey_free: (a: number, b: number) => void
export const __wbg_proposal_free: (a: number, b: number) => void
export const __wbg_seedfingerprint_free: (a: number, b: number) => void
export const __wbg_set_blockrange_0: (a: number, b: number) => void
export const __wbg_set_blockrange_1: (a: number, b: number) => void
export const __wbg_set_walletsummary_chain_tip_height: (a: number, b: number) => void
export const __wbg_set_walletsummary_fully_scanned_height: (a: number, b: number) => void
export const __wbg_set_walletsummary_next_ironwood_subtree_index: (a: number, b: bigint) => void
export const __wbg_set_walletsummary_next_orchard_subtree_index: (a: number, b: bigint) => void
export const __wbg_set_walletsummary_next_sapling_subtree_index: (a: number, b: bigint) => void
export const __wbg_transactionrequest_free: (a: number, b: number) => void
export const __wbg_unifiedfullviewingkey_free: (a: number, b: number) => void
export const __wbg_unifiedspendingkey_free: (a: number, b: number) => void
export const __wbg_walletsummary_free: (a: number, b: number) => void
export const __wbg_webvotingsession_free: (a: number, b: number) => void
export const __wbg_webwallet_free: (a: number, b: number) => void
export const generate_mnemonic: (a: number, b: number) => void
export const mnemonic_to_addresses: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number
) => void
export const mnemonic_to_seed: (a: number, b: number, c: number, d: number, e: number) => void
export const mnemonic_to_seed_fingerprint: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number
) => void
export const mnemonic_to_spending_key: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number
) => void
export const mnemonic_to_transparent_address: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number
) => void
export const parse_unified_address: (a: number, b: number, c: number, d: number, e: number) => void
export const paymentrequest_amount: (a: number) => bigint
export const paymentrequest_label: (a: number, b: number) => void
export const paymentrequest_memo: (a: number, b: number) => void
export const paymentrequest_message: (a: number, b: number) => void
export const paymentrequest_new: (
  a: number,
  b: number,
  c: number,
  d: bigint,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number
) => void
export const paymentrequest_other_params: (a: number, b: number) => void
export const paymentrequest_recipient_address: (a: number, b: number) => void
export const paymentrequest_simple_payment: (a: number, b: number, c: number, d: bigint) => void
export const pczt_apply_ledger_signatures: (a: number, b: number, c: number, d: number) => void
export const pczt_combine: (a: number, b: number, c: number) => void
export const pczt_from_bytes: (a: number, b: number, c: number) => void
export const pczt_from_json: (a: number, b: number) => void
export const pczt_redact_for_signer: (a: number) => number
export const pczt_serialize: (a: number, b: number) => void
export const pczt_to_json: (a: number, b: number) => void
export const pczt_to_ledger_signing_payload: (a: number, b: number, c: number) => void
export const seedfingerprint_from_bytes: (a: number, b: number, c: number) => void
export const seedfingerprint_new: (a: number, b: number, c: number) => void
export const seedfingerprint_to_bytes: (a: number, b: number) => void
export const sign_message_with_transparent: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number
) => void
export const start: () => void
export const transactionrequest_empty: () => number
export const transactionrequest_from_uri: (a: number, b: number, c: number) => void
export const transactionrequest_new: (a: number, b: number, c: number) => void
export const transactionrequest_payment_requests: (a: number, b: number) => void
export const transactionrequest_to_uri: (a: number, b: number) => void
export const transactionrequest_total: (a: number, b: number) => void
export const unifiedfullviewingkey_encode: (a: number, b: number, c: number, d: number) => void
export const unifiedfullviewingkey_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number
) => void
export const unifiedspendingkey_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
) => void
export const unifiedspendingkey_to_sapling_proof_generation_key: (a: number) => number
export const unifiedspendingkey_to_unified_full_viewing_key: (a: number) => number
export const validate_mnemonic: (a: number, b: number, c: number) => void
export const walletsummary_account_balances: (a: number, b: number) => void
export const webvotingsession_checkEligibility: (a: number, b: number, c: number) => number
export const webvotingsession_clearRound: (a: number, b: number, c: number) => number
export const webvotingsession_discoverRounds: (a: number) => number
export const webvotingsession_exportState: (a: number, b: number) => void
export const webvotingsession_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
) => void
export const webvotingsession_prepareRound: (a: number, b: number, c: number) => number
export const webvotingsession_resumeRound: (a: number, b: number, c: number) => number
export const webvotingsession_roundProposals: (a: number, b: number, c: number) => number
export const webvotingsession_roundStatus: (a: number, b: number, c: number) => number
export const webvotingsession_storageKey: (a: number, b: number) => void
export const webvotingsession_submitBallot: (a: number, b: number, c: number, d: number) => number
export const webvotingsession_submitDelegation: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number
) => number
export const webwallet_bench_download_range: (a: number, b: number, c: number) => number
export const webwallet_bench_prepare_sync_batch_timed: (a: number, b: number, c: number) => number
export const webwallet_create_account: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number
) => number
export const webwallet_create_account_ufvk: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number
) => number
export const webwallet_create_account_ufvk_external: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number
) => number
export const webwallet_db_to_bytes: (a: number) => number
export const webwallet_db_to_bytes_chunked: (a: number, b: number) => number
export const webwallet_estimate_orchard_migration_fee: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: bigint
) => number
export const webwallet_estimate_pczt_max_transfer: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: bigint
) => number
export const webwallet_estimate_pczt_max_transparent_transfer: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: bigint
) => number
export const webwallet_estimate_pczt_shield_fee: (a: number, b: number, c: bigint) => number
export const webwallet_estimate_pczt_transfer_fee: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: bigint
) => number
export const webwallet_estimate_pczt_transparent_transfer_fee: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: bigint
) => number
export const webwallet_estimate_transfer: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: bigint,
  l: number
) => number
export const webwallet_get_account_birthday: (a: number, b: number) => number
export const webwallet_get_account_hd_index: (a: number, b: number) => number
export const webwallet_get_account_id_by_name: (a: number, b: number, c: number) => number
export const webwallet_get_block_by_time: (a: number, b: number) => number
export const webwallet_get_block_time: (a: number, b: number) => number
export const webwallet_get_ironwood_activation_height: (a: number) => number
export const webwallet_get_latest_block: (a: number) => number
export const webwallet_get_latest_height: (a: number) => number
export const webwallet_get_next_shielded_address: (a: number, b: number) => number
export const webwallet_get_stored_transaction_bytes: (a: number, b: number, c: number) => number
export const webwallet_get_transaction_history: (a: number, b: number) => number
export const webwallet_get_unified_addresses: (a: number, b: number) => number
export const webwallet_get_wallet_summary: (a: number) => number
export const webwallet_list_shielded_addresses: (a: number, b: number) => number
export const webwallet_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number
) => void
export const webwallet_oneclick_pczt_orchard_migration: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: bigint,
  k: number
) => number
export const webwallet_oneclick_pczt_shield: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number
) => number
export const webwallet_oneclick_pczt_shield_dynamic_fee: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: bigint,
  g: number
) => number
export const webwallet_oneclick_pczt_transfer: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number
) => number
export const webwallet_oneclick_pczt_transfer_dynamic_fee: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: bigint,
  l: number
) => number
export const webwallet_oneclick_pczt_transparent_transfer: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number
) => number
export const webwallet_oneclick_pczt_transparent_transfer_dynamic_fee: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: bigint,
  l: number
) => number
export const webwallet_oneclick_transfer: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number,
  l: bigint,
  m: number
) => number
export const webwallet_pczt_create: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: bigint
) => number
export const webwallet_pczt_create_transparent: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: bigint,
  f: number,
  g: number,
  h: bigint
) => number
export const webwallet_pczt_orchard_migration_create: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: bigint,
  h: number
) => number
export const webwallet_pczt_prove: (a: number, b: number) => number
export const webwallet_pczt_prove_and_send: (a: number, b: number) => number
export const webwallet_pczt_shield_create: (a: number, b: number, c: bigint) => number
export const webwallet_pczt_store: (a: number, b: number) => number
export const webwallet_pczt_store_detailed: (a: number, b: number) => number
export const webwallet_prepare_sync_batch: (a: number, b: number, c: number) => number
export const webwallet_prepare_sync_batch_optimized: (a: number, b: number) => number
export const webwallet_replay_journal_entries: (a: number, b: number, c: number) => number
export const webwallet_scan_journal_entry: (a: number, b: number, c: number) => number
export const webwallet_send_authorized_transactions: (a: number, b: number, c: number) => number
export const webwallet_set_zero_indexer_options: (a: number, b: number, c: number) => void
export const webwallet_sync: (a: number) => number
export const webwallet_sync_next_batch: (a: number, b: number) => number
export const webwallet_sync_next_batch_optimized: (a: number, b: number) => number
export const webwallet_sync_session_setup: (a: number) => number
export const task_worker_entry_point: (a: number, b: number) => void
export const __wbg_canary_free: (a: number, b: number) => void
export const __wbg_coordinator_free: (a: number, b: number) => void
export const __wbg_deposit_free: (a: number, b: number) => void
export const __wbg_dkg1_free: (a: number, b: number) => void
export const __wbg_dkg2_free: (a: number, b: number) => void
export const __wbg_dkg3_free: (a: number, b: number) => void
export const __wbg_dkg_free: (a: number, b: number) => void
export const __wbg_dkgrelay_free: (a: number, b: number) => void
export const __wbg_messageset_free: (a: number, b: number) => void
export const __wbg_noisexx_free: (a: number, b: number) => void
export const __wbg_rostermanifest_free: (a: number, b: number) => void
export const __wbg_sharebackup_free: (a: number, b: number) => void
export const __wbg_signer_free: (a: number, b: number) => void
export const canary_allows: (a: number, b: number) => number
export const canary_arrival_confirmed: (a: number, b: number) => void
export const canary_begin: (a: number, b: number, c: number) => void
export const canary_new: () => number
export const canary_phase: (a: number, b: number) => void
export const canary_spend_confirmed: (a: number, b: number) => void
export const coordinator_accept_commitments: (a: number, b: number, c: number, d: number) => void
export const coordinator_accept_reject: (a: number, b: number, c: number, d: number) => void
export const coordinator_accept_share: (a: number, b: number, c: number, d: number) => void
export const coordinator_actions: (a: number) => number
export const coordinator_aggregate: (a: number, b: number) => void
export const coordinator_init_all: (a: number, b: number) => void
export const coordinator_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number
) => void
export const coordinator_payloads: (a: number, b: number) => void
export const coordinator_phase: (a: number, b: number) => void
export const coordinator_prepare_payload: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
) => void
export const coordinator_report_result: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number
) => void
export const deposit_canary_amount: () => number
export const deposit_denom_cap: () => number
export const deposit_is_canonical: (a: number) => number
export const deposit_plan: (a: number, b: number) => void
export const deposit_residual: (a: number, b: number) => void
export const dkg1_broadcast: (a: number) => number
export const dkg1_broadcast_envelope: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
) => void
export const dkg1_secret: (a: number) => number
export const dkg1_static_public: (a: number) => number
export const dkg2_outgoing: (a: number) => number
export const dkg2_outgoing_envelope: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
) => void
export const dkg2_secret: (a: number) => number
export const dkg2_statics: (a: number) => number
export const dkg3_group_verifying_key: (a: number, b: number) => void
export const dkg3_key_package: (a: number) => number
export const dkg3_public_key_package: (a: number) => number
export const dkg3_static_public: (a: number) => number
export const dkg3_static_secret: (a: number) => number
export const dkg3_statics: (a: number) => number
export const dkg_new: (a: number, b: number, c: number, d: number, e: number, f: number) => void
export const dkg_part1: (a: number, b: number) => void
export const dkg_part2: (a: number, b: number, c: number, d: number, e: number) => void
export const dkg_part3: (a: number, b: number, c: number, d: number, e: number, f: number) => void
export const dkg_slot: (a: number) => number
export const dkg_static_public_of_broadcast: (a: number, b: number, c: number) => void
export const dkgrelay_accept: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
) => void
export const dkgrelay_bundle: (a: number, b: number, c: number, d: number, e: number) => void
export const dkgrelay_new: (a: number, b: number, c: number, d: number) => void
export const envelopecodec_build: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number
) => void
export const envelopecodec_buildSignReject: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number
) => void
export const envelopecodec_buildSignResult: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number
) => void
export const envelopecodec_buildSigning: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number
) => void
export const envelopecodec_coordinator_slot: () => number
export const envelopecodec_decode: (a: number, b: number, c: number) => void
export const envelopecodec_defined_msg_types: () => number
export const envelopecodec_msg_type: (a: number, b: number, c: number) => void
export const envelopecodec_readSignReject: (a: number, b: number, c: number) => void
export const envelopecodec_readSignResult: (a: number, b: number, c: number) => void
export const envelopecodec_readSigning: (a: number, b: number, c: number) => void
export const envelopecodec_rejectCode: (a: number, b: number, c: number) => void
export const envelopecodec_reserved_msg_type: (a: number, b: number, c: number) => void
export const envelopecodec_reserved_msg_types: () => number
export const envelopecodec_round_of: (a: number, b: number, c: number) => void
export const keyset_address_is_shielded_only: (a: number, b: number) => number
export const keyset_derive: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number
) => void
export const keyset_fingerprint_from_fvk: (a: number, b: number, c: number, d: number) => void
export const keyset_fingerprint_from_ufvk: (a: number, b: number, c: number, d: number) => void
export const keyset_fvk_from_ufvk: (a: number, b: number, c: number) => void
export const keyset_generate_qsk: () => number
export const keyset_ufvk_matches_ak: (a: number, b: number, c: number, d: number, e: number) => void
export const messageset_from_bytes: (a: number, b: number, c: number) => void
export const messageset_get: (a: number, b: number) => number
export const messageset_is_empty: (a: number) => number
export const messageset_len: (a: number) => number
export const messageset_new: () => number
export const messageset_set: (a: number, b: number, c: number, d: number) => void
export const messageset_slots: (a: number, b: number) => void
export const messageset_to_bytes: (a: number, b: number) => void
export const noisexx_decrypt: (a: number, b: number, c: number, d: number) => void
export const noisexx_encrypt: (a: number, b: number, c: number, d: number) => void
export const noisexx_handshake_hash: (a: number, b: number) => void
export const noisexx_initiator: (a: number, b: number, c: number, d: number, e: number) => void
export const noisexx_is_handshake_finished: (a: number) => number
export const noisexx_is_poisoned: (a: number) => number
export const noisexx_read_handshake: (a: number, b: number, c: number, d: number) => void
export const noisexx_rekey: (a: number, b: number) => void
export const noisexx_remote_static: (a: number) => number
export const noisexx_responder: (a: number, b: number, c: number, d: number, e: number) => void
export const noisexx_static_public_from: (a: number, b: number, c: number) => void
export const noisexx_write_handshake: (a: number, b: number, c: number, d: number) => void
export const pczttools_action_alphas: (a: number, b: number, c: number) => void
export const pczttools_action_rks: (a: number, b: number, c: number) => void
export const pczttools_apply_signatures: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number
) => void
export const pczttools_check: (a: number, b: number, c: number) => void
export const pczttools_check_action_bindings: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number
) => void
export const pczttools_review: (a: number, b: number, c: number, d: number, e: number) => void
export const pczttools_shielded_sighash: (a: number, b: number, c: number) => void
export const pczttools_signingSet: (a: number, b: number, c: number, d: number, e: number) => void
export const pczttools_strip_proofs: (a: number, b: number, c: number) => void
export const rostermanifest_add_participant: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number
) => void
export const rostermanifest_canonical_bytes: (a: number, b: number) => void
export const rostermanifest_hash: (a: number, b: number) => void
export const rostermanifest_hash_hex: (a: number, b: number) => void
export const rostermanifest_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number
) => void
export const sealed_open: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number
) => void
export const sealed_prologue: (a: number, b: number) => void
export const sealed_prologueWithTranscript: (a: number, b: number, c: number) => void
export const sealed_seal: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number
) => void
export const sessionmarker_committed: (a: number, b: number, c: number) => void
export const sessionmarker_created: (a: number, b: number, c: number) => void
export const sessionmarker_recover: (a: number, b: number, c: number) => void
export const sessionmarker_session_id: (a: number, b: number, c: number) => void
export const sharebackup_device_id: (a: number) => number
export const sharebackup_from_bytes: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
) => void
export const sharebackup_from_scalar: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number,
  k: number,
  l: number,
  m: number
) => void
export const sharebackup_group_verifying_key: (a: number) => number
export const sharebackup_key_package: (a: number, b: number) => void
export const sharebackup_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number,
  j: number
) => void
export const sharebackup_signing_scalar: (a: number, b: number) => void
export const sharebackup_slot: (a: number) => number
export const sharebackup_to_bytes: (a: number, b: number) => void
export const sharebackup_vault_id: (a: number) => number
export const signer_approve: (a: number, b: number) => void
export const signer_init: (a: number, b: number, c: number, d: number) => void
export const signer_new: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number
) => void
export const signer_nonce_states: (a: number, b: number) => void
export const signer_on_result: (a: number, b: number, c: number, d: number) => void
export const signer_payload: (a: number, b: number, c: number, d: number) => void
export const signer_phase: (a: number, b: number) => void
export const signer_reject: (a: number, b: number, c: number, d: number, e: number) => void
export const signer_share: (a: number, b: number) => void
export const signing_phases: () => number
export const verification_rk: (a: number, b: number, c: number, d: number, e: number) => void
export const verification_verify_spend_auth: (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
  h: number,
  i: number
) => void
export const envelopecodec_new_session_id: () => number
export const __wbg_envelopecodec_free: (a: number, b: number) => void
export const __wbg_keyset_free: (a: number, b: number) => void
export const __wbg_pczttools_free: (a: number, b: number) => void
export const __wbg_sealed_free: (a: number, b: number) => void
export const __wbg_sessionmarker_free: (a: number, b: number) => void
export const __wbg_verification_free: (a: number, b: number) => void
export const __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void
export const initThreadPool: (a: number) => number
export const wbg_rayon_poolbuilder_build: (a: number) => void
export const wbg_rayon_poolbuilder_numThreads: (a: number) => number
export const wbg_rayon_poolbuilder_receiver: (a: number) => number
export const wbg_rayon_start_worker: (a: number) => void
export const rust_sqlite_wasm_abort: () => void
export const rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void
export const rust_sqlite_wasm_calloc: (a: number, b: number) => number
export const rust_sqlite_wasm_free: (a: number) => void
export const rust_sqlite_wasm_getentropy: (a: number, b: number) => number
export const rust_sqlite_wasm_localtime: (a: number) => number
export const rust_sqlite_wasm_malloc: (a: number) => number
export const rust_sqlite_wasm_realloc: (a: number, b: number) => number
export const sqlite3_os_end: () => number
export const sqlite3_os_init: () => number
export const __wbg_intounderlyingbytesource_free: (a: number, b: number) => void
export const __wbg_intounderlyingsink_free: (a: number, b: number) => void
export const __wbg_intounderlyingsource_free: (a: number, b: number) => void
export const intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number
export const intounderlyingbytesource_cancel: (a: number) => void
export const intounderlyingbytesource_pull: (a: number, b: number) => number
export const intounderlyingbytesource_start: (a: number, b: number) => void
export const intounderlyingbytesource_type: (a: number) => number
export const intounderlyingsink_abort: (a: number, b: number) => number
export const intounderlyingsink_close: (a: number) => number
export const intounderlyingsink_write: (a: number, b: number) => number
export const intounderlyingsource_cancel: (a: number) => void
export const intounderlyingsource_pull: (a: number, b: number) => number
export const rustsecp256k1_v0_14_default_error_callback_fn: (a: number, b: number) => void
export const rustsecp256k1_v0_14_default_illegal_callback_fn: (a: number, b: number) => void
export const rustsecp256k1_v0_14_context_create: (a: number) => number
export const rustsecp256k1_v0_14_context_destroy: (a: number) => void
export const __wasm_bindgen_func_elem_16707: (a: number, b: number, c: number, d: number) => void
export const __wasm_bindgen_func_elem_16724: (a: number, b: number, c: number, d: number) => void
export const __wasm_bindgen_func_elem_12601: (a: number, b: number, c: number) => void
export const __wasm_bindgen_func_elem_16709: (a: number, b: number, c: number) => void
export const __wasm_bindgen_func_elem_12524: (a: number, b: number) => void
export const memory: WebAssembly.Memory
export const __wbindgen_export: (a: number, b: number) => number
export const __wbindgen_export2: (a: number, b: number, c: number, d: number) => number
export const __wbindgen_export3: (a: number) => void
export const __wbindgen_export4: (a: number, b: number, c: number) => void
export const __wbindgen_export5: (a: number, b: number) => void
export const __wbindgen_add_to_stack_pointer: (a: number) => number
export const __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void
export const __wbindgen_start: (a: number) => void
