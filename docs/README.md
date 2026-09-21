# Documentation

Documentation for the `interledger-test` project — a Bun + TypeScript sandbox for the
[Interledger Open Payments](https://openpayments.dev) API.

| Document | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | System context, module map, runtime flows and the Open Payments protocol sequences (Mermaid diagrams) |
| [review.md](./review.md) | Findings from the code review: what works, what is broken, and what to do next |

## Quick orientation

All source lives under [`ts/`](../ts). The repository is a **client-only exploration**:
no server, no database, no persistence. It authenticates against a wallet's Open
Payments servers with an Ed25519 key and drives payments over HTTPS.

| File | Role |
| --- | --- |
| [`ts/config.ts`](../ts/config.ts) | Typed environment boundary — validates every variable and decodes the private key |
| [`ts/wallets.ts`](../ts/wallets.ts) | Read-only probe: prints a wallet address and its JWKS. Use it to confirm credentials |
| [`ts/simulate-payment.ts`](../ts/simulate-payment.ts) | The full 7-step payment workflow, live or stubbed |
| [`ts/index.ts`](../ts/index.ts) | Unused stub — see [review.md](./review.md) |

## Running it

```bash
cd ts
bun install

bun run simulate:dry      # the whole workflow offline — no .env, no network
bun run typecheck         # tsc --noEmit

cp .env.example .env      # then fill it in for live mode
bun run wallets           # verify credentials
bun run simulate          # live payment; pauses for browser approval at step 6
```

**Start with `bun run simulate:dry`.** It walks all seven protocol steps with stubbed
responses and needs no credentials, so it is the quickest way to see the flow in
[architecture.md §4](./architecture.md#4-the-full-payment-workflow) actually run.

## Environment variables

Documented in full in [`ts/.env.example`](../ts/.env.example). None are needed for the
dry run.

| Variable | Required | Notes |
| --- | --- | --- |
| `SENDER_WALLET_ADDRESS` | live | Wallet the payment leaves from. Falls back to `WALLET_ADDRESS` |
| `RECEIVER_WALLET_ADDRESS` | live | Wallet the payment goes to |
| `KEY_ID` | live | `kid` of the public key registered on the sender's wallet address |
| `PRIVATE_KEY` | live | **base64 of the Ed25519 PEM file**, not the PEM text |
| `CLIENT_WALLET_ADDRESS` | optional | GNAP client identity; defaults to the sender |
| `INTERACT_REDIRECT_URI` | optional | Defaults to `http://localhost:3344/callback` |

Test wallets and developer keys come from <https://wallet.interledger-test.dev>.
