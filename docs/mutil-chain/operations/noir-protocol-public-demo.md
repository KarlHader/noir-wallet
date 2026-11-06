# Noir Protocol Public DeFi Demo Integration

This guide is for developers testing the Public demo. These APIs are experimental and may change; use the extension and workspace SDK from the same checkout. Public uses a CAIP-25 EVM or Zcash authorization, with a NEAR MCA for assets and execution. Zcash retains its Lending signing identity; EVM uses the authorized EVM identity. Its balances remain separate from native-chain balances. MCA bindings also depend on the configured parent contract; deployments with different parents may return different MCAs for the same key.

## Local Setup

Follow the repository [development setup](../../../README.md#development). From the repository root, build the workspace SDK and start the example:

```bash
pnpm --filter @noir-wallet/sdk build
pnpm dev:example
```

In another terminal, run `pnpm dev:extension` and load `packages/extension/dist-dev/` through **Load unpacked** in `chrome://extensions`. Open [the Public demo](http://localhost:5002/example/#noir-public) and select **Connect**. Automatic selection reuses an existing MCA, then prefers a supported chain with native Gas; the chain selector provides a manual override. The demo stays in the [existing SDK example](../../../packages/sdk/example/src/noir-protocol/public/), sharing its SDK and build.

Use a mnemonic software account or an imported EVM private-key account in Mainnet mode. The current [Public configuration](../../../packages/extension/src/core/services/noir-protocol/public/config.ts) defines the deployment and supported tokens; Testnet and hardware accounts are unavailable. Mainnet development services are not a testnet. Use an isolated test wallet and an explicit spending limit for funded integration. Use the controlled verification below when real funds are unnecessary.

For temporary integration in another dApp, download the checked SDK artifact from the PR's successful **SDK CI** run, extract its tarball, and install it with `pnpm add /path/to/noir-wallet-sdk-<version>.tgz`. Use the paired extension from the same tested commit and keep the generated lockfile. Artifact downloads require GitHub access. Earlier manually published tarballs may use a different experimental API; the version string alone does not identify this preview.

## Integration Flow

Follow the [SDK Public integration reference](../../../packages/sdk/README.md#noir-protocol-public-experimental) for identity selection, authorization, account events, message signing, and wallet-managed transaction APIs. The steps below cover the demo's activation and transaction workflow.

Activation needs an acceptable bridge quote, the creation payment, and the selected chain's network fee. An unavailable or unverified quote blocks activation. Account and asset reads never initiate that payment. The activation refund uses the selected wallet identity's address and may link it to the Public account.

Each `txRequests` entry has this shape; replace the placeholder contract and method with the deployment being tested:

```ts
{
  FunctionCall: {
    receiver_id: 'contract.example',
    function_calls: [{
      method_name: 'method',
      args: JSON.stringify({ value: 'example' }),
      gas: '30000000000000',
      deposit: '0'
    }]
  }
}
```

`args` is a JSON string, not an object or Base64 string. `gas` and `deposit` are decimal strings in gas units and yoctoNEAR. With `sendPublicTransaction`, the wallet selects the signing identity, MCA, network, and nonce; the dApp supplies the calls to review. The wallet adds a ZEC execution-fee transfer to the approval and signed calls, so reserve Public ZEC for that fee instead of transferring the entire balance.

Before an NEP-141 transfer, check the receiver's `storage_balance_of`. If it is `null`, include `storage_deposit({ account_id: receiver, registration_only: true })` before `ft_transfer` in the same token contract's `function_calls`. Read the deposit from `storage_balance_bounds`; the MCA needs native NEAR for this deposit. The demo's FunctionCall editor can submit this sequence; its token-transfer form only builds `ft_transfer`.

Persist one `requestId` and its unchanged request body for each intended operation. If submission times out or its response is lost, retry that same pair to recover the original operation. Use a new ID only for a new intended operation.

The demo offers a token-transfer form and a FunctionCall editor. Once sent, **Retry same request** keeps the original ID and body; **New intent** unlocks editing for another operation. Compare the displayed SDK and wallet versions, network, parent contract, and reviewed request when investigating an integration failure. **SDK trace** shows method outcomes, elapsed time, and error codes. Its export contains only diagnostic metadata; inspect account, request, and operation details locally in the page.

Poll the returned `operationId` until `status` is `final` or `failed`. `signed`, `broadcast`, and `confirming` are pending states; API acceptance does not establish execution success. `final` represents verified NEAR execution, while `anchor` tracks subsequent anchoring separately. A `null` lookup means the operation is unavailable to the current account and origin, not proof that it never executed.

Refresh assets after execution. Interpret `balanceRaw` with its token's `decimals` and `status` (`fresh`, `stale`, or `unavailable`); a missing balance is not zero. Keep Public token IDs distinct from native Zcash assets. Re-import can rediscover the MCA and balances; local operation history is not restored from the chain.

## Controlled Verification

From the repository root:

```bash
E2E_SCREENSHOTS=1 pnpm test e2e protocol-mainnet --grep Public
```

This runs the real isolated MV3 extension, provider, approval UI, and Worker signing with controlled service responses. It exercises inactive-account reads, activation failure, transaction approval and rejection, repeated requests, response loss, Service Worker recovery, and account rediscovery after re-import. Screenshots remain in ignored `e2e-output/`.

These service substitutions apply only to the test runner. The ordinary SDK example uses the extension's configured services. The controlled run does not demonstrate a live creation payment or live asset withdrawal.
