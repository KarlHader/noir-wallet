# Test Wallet Registry

Reusable test wallets are registered here. Tests may create temporary, unfunded wallets, but any wallet reused across runs needs a named slot. Never place a funded wallet's mnemonic, password, or private key in Git-tracked files. Keep each secret in a separate absolute-path file outside Git tracking with mode `0600`; the local registry holds only paths and non-secret metadata.

## Public, Permanently Unfunded Vectors

These vectors are public and may be swept automatically. Never request or store Mainnet or Testnet assets in them.

| ID                          | Public vector                                                                                                                                               | Purpose                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public-abandon-12`         | `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`                                                             | V1 compatibility, both WASM packages, session/resource checks, and primary UI regression. EVM Account 0: `0x9858EfFD232B4033E47d90003D41EC34EcaEda94`.                                                    |
| `public-abandon-24`         | `abandon` × 23 + `art`                                                                                                                                      | 24-word import, EVM/Bitcoin Testnet, Receive, and dApp regression. Sepolia Account 0: `0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb`; Bitcoin Testnet BIP-84: `tb1qtk89me2ae95dmlp3yfl4q9ynpux8mxjujuf2fr`. |
| `public-legal-winner-12`    | `legal winner thank year wave sausage worth useful legal winner thank yellow`                                                                               | Second 12-word wallet and multi-wallet/account-tree checks.                                                                                                                                               |
| `public-hardhat-12`         | `test test test test test test test test test test test junk`                                                                                               | Command and SDK logic tests only; do not use on a public network.                                                                                                                                         |
| `public-private-key-1`      | `0x0000000000000000000000000000000000000000000000000000000000000001`                                                                                        | Public EVM/Bitcoin private-key import, export, password change, and signing vector. EVM address: `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`. Never fund it.                                             |
| `v1.0.30-golden-profile`    | Encrypted envelope and IndexedDB snapshot in `packages/extension/tests/fixtures/v1.0.30-mainnet-software-golden.json`; no plaintext credential stored here. | V1-to-V2 upgrade and storage compatibility. The immutable fixture comes from released `v1.0.30@a623a1c39f89b44a139ebadfcd3e3441de0b7cf9`; do not regenerate or edit it from current V2 code.              |
| `generated-create-wallet-*` | Generated temporarily by the pinned WASM package in each test.                                                                                              | Creation and entropy checks. Never fund or reuse across tests; delete with the isolated browser profile.                                                                                                  |

`0x1111111111111111111111111111111111111111` is a deterministic EVM recipient, not a controlled test wallet.

`public-ledger-signing-vectors` uses public 32-byte secp256k1 scalars filled with `03`, BIP-32 master seeds of 64 bytes filled with `03` or 32 bytes filled with `05`, and 32-byte Ed25519 seeds filled with `07` or `08`. These permanently unfunded vectors exercise Ledger public-export validation, isolated MV3 provisioning, PSBT/BIP-322 verification, and Solana/NEAR signature verification. They never stand in for a physical device export or a funded integration wallet.

## Live-Test Boundaries

- Keep funded wallet configuration local. Revalidate the network, derivation, and spendable balance before running a funded test. Never use public vectors for faucet or real-balance checks.
- Authorize the transaction before enabling broadcast. Never store broadcast switches in persistent configuration.
- Screenshots, traces, console output, and failure messages must not contain local paths, mnemonics, passwords, private keys, raw vaults, or signing session data.
