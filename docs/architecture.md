# Architecture

`interledger-test` is a Bun + TypeScript client for the
[Interledger Open Payments](https://openpayments.dev) API. It has no server, no
database and no UI: every diagram below describes a **process that starts, talks to
somebody else's wallet infrastructure over HTTPS, and exits**.

Understanding the architecture therefore means understanding two things:

1. which pieces of remote infrastructure a wallet exposes, and
2. the strict order in which they must be called to move money.

---

## 1. System context

Open Payments splits a wallet into three independent HTTP services. A client never
hardcodes their URLs — it discovers them by fetching the wallet address, which acts as
the entry point for everything else.

```mermaid
graph LR
    subgraph local["Local process (Bun runtime)"]
        direction TB
        ENV[".env<br/>SENDER_WALLET_ADDRESS · RECEIVER_WALLET_ADDRESS<br/>KEY_ID · PRIVATE_KEY"]
        APP["scripts<br/>wallets.ts · simulate-payment.ts"]
        SDK["@interledger/open-payments<br/>AuthenticatedClient"]
        ENV --> APP
        APP --> SDK
    end

    subgraph sender["Sender wallet (payer)"]
        direction TB
        SWA["Wallet Address<br/>public metadata + JWKS"]
        SAS["Auth Server<br/>GNAP grants"]
        SRS["Resource Server<br/>quotes · outgoing payments"]
    end

    subgraph receiver["Receiver wallet (payee)"]
        direction TB
        RWA["Wallet Address<br/>public metadata + JWKS"]
        RAS["Auth Server<br/>GNAP grants"]
        RRS["Resource Server<br/>incoming payments"]
    end

    SDK -->|"GET (public)"| SWA
    SDK -->|"GET (public)"| RWA
    SDK -->|"POST · signed"| SAS
    SDK -->|"POST · signed"| RAS
    SDK -->|"Bearer token + signature"| SRS
    SDK -->|"Bearer token + signature"| RRS

    SRS -.->|"ILP packets<br/>(settlement, outside this app)"| RRS

    classDef localBox fill:#e8f0fe,stroke:#4285f4,color:#111
    classDef remoteBox fill:#fff4e5,stroke:#f5a623,color:#111
    class ENV,APP,SDK localBox
    class SWA,SAS,SRS,RWA,RAS,RRS remoteBox
```

Key point: **the sender and the receiver each have their own auth server.** A payment
requires grants from both. The actual value transfer (the dashed line) happens over
Interledger between the two resource servers and is never touched by this codebase.

---

## 2. Module map

```mermaid
graph TD
    ENVFILE[".env"] -->|"Bun auto-loads"| BUNENV["Bun.env"]
    BUNENV --> CONFIG["config.ts<br/>validates + decodes secrets"]
    CONFIG -->|"PEM decoded from base64"| KEY["Ed25519 private key"]

    CONFIG --> WALLETS["wallets.ts<br/>read-only probe"]
    CONFIG --> SIM["simulate-payment.ts<br/>full payment workflow"]

    WALLETS --> CLIENT
    SIM --> CLIENT

    subgraph clientbox["createAuthenticatedClient()"]
        CLIENT["AuthenticatedClient"]
        CLIENT --> R1["walletAddress<br/>get · getKeys · getDIDDocument"]
        CLIENT --> R2["grant<br/>request · continue · cancel"]
        CLIENT --> R3["incomingPayment<br/>create · get · complete · list"]
        CLIENT --> R4["quote<br/>create · get"]
        CLIENT --> R5["outgoingPayment<br/>create · get · list"]
        CLIENT --> R6["token<br/>rotate · revoke"]
    end

    KEY -.->|"signs every request<br/>(HTTP Message Signatures)"| CLIENT
    CLIENT -->|"validates responses<br/>against OpenAPI specs"| OUT(("Open Payments<br/>servers"))
```

`wallets.ts` exercises only the top route (`walletAddress`, unauthenticated).
`simulate-payment.ts` exercises the whole surface — see §4.

---

## 3. What `wallets.ts` does today

The smallest possible end-to-end proof that the key material is correct.

```mermaid
sequenceDiagram
    autonumber
    participant Bun as Bun runtime
    participant App as wallets.ts
    participant SDK as AuthenticatedClient
    participant WA as Wallet Address server

    Bun->>App: load .env, run top-level await
    App->>SDK: createAuthenticatedClient({walletAddressUrl, privateKey, keyId})
    Note over SDK: fetches + caches the Open Payments<br/>OpenAPI specs for response validation
    SDK-->>App: client

    App->>SDK: walletAddress.get({url})
    SDK->>WA: GET /alice
    WA-->>SDK: 200 {id, authServer, resourceServer, assetCode, assetScale}
    SDK-->>App: WalletAddress

    App->>SDK: walletAddress.getKeys({url})
    SDK->>WA: GET /alice/jwks.json
    WA-->>SDK: 200 JWKS
    SDK-->>App: JWKS
    App->>Bun: console.log both, exit
```

If the JWKS contains the public key matching `KEY_ID`, the credentials are wired up
correctly and the full workflow in §4 can run.

---

## 4. The full payment workflow

This is the sequence the simulation script walks. Every step is mandatory and the order
is fixed by the protocol: you cannot quote before the incoming payment exists, and you
cannot pay before the quote exists.

```mermaid
sequenceDiagram
    autonumber
    actor User as Resource Owner<br/>human in a browser
    participant App as simulate-payment.ts
    participant RAS as Receiver Auth Server
    participant RRS as Receiver Resource Server
    participant SAS as Sender Auth Server
    participant SRS as Sender Resource Server

    rect rgb(232, 240, 254)
    Note over App,RRS: Phase 1 — set up the destination
    App->>RRS: GET receiver wallet address
    RRS-->>App: {authServer, resourceServer, assetCode, assetScale}
    App->>RAS: grant.request(type incoming-payment, actions create/read/complete)
    RAS-->>App: Grant (non-interactive) + access token
    App->>RRS: incomingPayment.create({incomingAmount})
    RRS-->>App: IncomingPayment {id, methods[ilp]}
    end

    rect rgb(255, 244, 229)
    Note over App,SRS: Phase 2 — price the payment
    App->>SAS: grant.request(type quote, actions create/read)
    SAS-->>App: Grant (non-interactive) + access token
    App->>SRS: quote.create({receiver: incomingPayment.id, method: ilp})
    SRS-->>App: Quote {debitAmount, receiveAmount, expiresAt}
    end

    rect rgb(234, 247, 237)
    Note over User,SRS: Phase 3 — get the human's consent
    App->>SAS: grant.request(type outgoing-payment,<br/>limits.debitAmount = quote.debitAmount,<br/>interact.start = redirect)
    SAS-->>App: PendingGrant {interact.redirect, continue.uri, continue.access_token}
    App-->>User: open the redirect URL
    User->>SAS: review and approve the amount
    SAS-->>User: redirect back with interact_ref
    User-->>App: interact_ref
    App->>SAS: grant.continue({interact_ref})
    SAS-->>App: Grant + outgoing-payment access token
    end

    rect rgb(253, 236, 234)
    Note over App,SRS: Phase 4 — move the money
    App->>SRS: outgoingPayment.create({quoteId})
    SRS-->>App: OutgoingPayment {sentAmount, failed:false}
    Note over SRS,RRS: ILP settlement happens here,<br/>asynchronously, between the two wallets
    App->>SRS: outgoingPayment.get(id) — poll until sentAmount settles
    SRS-->>App: OutgoingPayment {sentAmount, receiveAmount, debitAmount}
    end
```

### Running this workflow

[`ts/simulate-payment.ts`](../ts/simulate-payment.ts) implements exactly the sequence
above, printing each step as it goes.

```bash
cd ts
bun run simulate:dry              # all 7 steps, stubbed, no network, no credentials
bun run simulate:dry --amount=250 # 2.50 in an assetScale-2 currency
bun run simulate                  # live; needs .env, pauses for browser approval
bun run typecheck
```

`--dry-run` swaps a `DryRunBackend` in behind the same interface the live client
implements, so the control flow, the branching on `PendingGrant`, and the settlement
polling loop are all exercised offline. It is the fastest way to read the protocol.

Step 6 is the only one that cannot be automated in live mode: the script prints the
`interact.redirect` URL, waits on stdin, and accepts either the bare `interact_ref` or
the whole redirect URL pasted back.

### Why phase 3 is interactive and the others are not

`incoming-payment` and `quote` grants are non-interactive: receiving money and asking
for a price are not sensitive. `outgoing-payment` **spends someone's money**, so GNAP
requires the resource owner to approve it in a browser. That is why the script pauses
there — it is a protocol requirement, not a limitation of the script.

---

## 5. Grant lifecycle

Both grant shapes returned by `grant.request()` are modelled here. The SDK returns a
union — `PendingGrant` when interaction is required, `Grant` when it is not — so
branching on it is mandatory before reading `access_token`.

```mermaid
stateDiagram-v2
    [*] --> Requested: grant.request()

    Requested --> Granted: non-interactive<br/>(incoming-payment, quote)
    Requested --> Pending: interactive<br/>(outgoing-payment)

    Pending --> AwaitingApproval: redirect the user to interact.redirect
    AwaitingApproval --> Approved: user approves, returns interact_ref
    AwaitingApproval --> Denied: user rejects
    Approved --> Granted: grant.continue({interact_ref})

    Granted --> InUse: use access_token on the resource server
    InUse --> Granted: token.rotate() before expiry
    InUse --> Revoked: token.revoke()
    Granted --> Revoked: grant.cancel()

    Denied --> [*]
    Revoked --> [*]
```

---

## 6. Request signing

Every authenticated call is signed with the Ed25519 key. This is what makes the
`KEY_ID` / `PRIVATE_KEY` pair meaningful: the server fetches the client's own wallet
address JWKS, finds the key with that id, and verifies the signature.

```mermaid
graph LR
    A["outgoing request"] --> B["build signature base<br/>(@method, @target-uri,<br/>content-digest, authorization)"]
    B --> C["sign with Ed25519 private key"]
    C --> D["add headers<br/>Signature · Signature-Input"]
    D --> E(("Open Payments server"))
    E --> F["GET client wallet address JWKS"]
    F --> G{"key id matches?<br/>signature valid?"}
    G -->|yes| H["process request"]
    G -->|no| I["401 / 403"]
```

The client's `walletAddressUrl` therefore serves double duty: it identifies the client
to every server it talks to, and it is where those servers go to find the public key.

---

## 7. Trust and data boundaries

| Boundary | What crosses it | Risk to watch |
| --- | --- | --- |
| `.env` -> process | `PRIVATE_KEY` (base64 PEM), `KEY_ID`, wallet URLs | `.env` must never be committed; the decoded PEM must never be logged |
| process -> auth servers | signed grant requests; received access tokens | tokens are bearer credentials — treat console output as sensitive |
| process -> resource servers | payment instructions carrying real amounts | `limits.debitAmount` on the outgoing grant is the spending ceiling |
| sender wallet -> receiver wallet | ILP settlement | entirely outside this codebase; observable only via `sentAmount` |

---

## 8. Current state vs. the protocol

```mermaid
graph LR
    subgraph implemented["Implemented"]
        I1["wallet address discovery"]
        I2["JWKS retrieval"]
        I3["authenticated client + signing"]
        I4["full workflow simulation"]
    end
    subgraph notyet["Not implemented"]
        N1["automated tests"]
        N2["token rotation / revocation on exit"]
        N3["persistence of grants and payments"]
        N4["any server or UI"]
    end
    implemented --> notyet

    classDef done fill:#eaf7ed,stroke:#34a853,color:#111
    classDef todo fill:#fdecea,stroke:#ea4335,color:#111
    class I1,I2,I3,I4 done
    class N1,N2,N3,N4 todo
```

See [review.md](./review.md) for the detailed findings behind the right-hand column.
