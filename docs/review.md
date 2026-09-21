# Code Review — `ts/` (Interledger Open Payments spike)

Scope: `ts/index.ts`, `ts/wallets.ts`, `ts/package.json`, `ts/tsconfig.json`,
`ts/.env.example`, `ts/.gitignore`, `ts/README.md`, `ts/CLAUDE.md`, as on disk.
`node_modules/` and `bun.lock` contents excluded.

## Summary

A single-file sandbox that authenticates against the Interledger Open Payments API
(`@interledger/open-payments@^7.1.3`) on Bun and prints a wallet address and its public
keys. Maturity is pre-alpha: 18 lines of real logic, no tests, no npm scripts, and a README
still at `bun init` defaults. The TypeScript config is genuinely strict and the dependency
set is minimal and locked, so the foundation is sound — but the code does not currently
typecheck under that strictness, and no network call has error handling. Verdict: fine as a
throwaway spike, not yet a safe seed for a real client.

## What the code does today

`ts/index.ts:1` is a one-line stub, `console.log("Test")`. Nothing imports it.

`ts/wallets.ts` is the real entry point and runs entirely at module top level:

1. `ts/wallets.ts:3-7` — builds an authenticated client via `createAuthenticatedClient`,
   reading `WALLET_ADDRESS`, `PRIVATE_KEY`, `KEY_ID` straight off `Bun.env`. `PRIVATE_KEY`
   is expected base64 and decoded to UTF-8 at `ts/wallets.ts:5`.
2. `ts/wallets.ts:9-11` — `walletAddress.get()` fetches the wallet address resource (public
   metadata: asset code/scale, auth server).
3. `ts/wallets.ts:12-14` — `walletAddress.getKeys()` fetches the public JWK set.
4. `ts/wallets.ts:16-17` — `console.log`s both responses in full.

No exported function, no CLI surface, no exit-code handling. `bun wallets.ts` is the only
useful invocation; `bun run index.ts` (what the README says) prints `Test`.

## Findings

### 1. High — does not compile under the project's own strict config

`bunx tsc --noEmit` produces exactly 4 errors, all in `ts/wallets.ts`, one root cause:
`Bun.env.X` is `string | undefined` where the SDK requires `string`.

| Location | Code | Symbol |
| --- | --- | --- |
| `ts/wallets.ts:4` | TS2769 | `createAuthenticatedClient` → `walletAddressUrl` |
| `ts/wallets.ts:5` | TS2769 | `Buffer.from(Bun.env.PRIVATE_KEY, "base64")` |
| `ts/wallets.ts:10` | TS2322 | `walletAddress.get({ url })` |
| `ts/wallets.ts:13` | TS2322 | `walletAddress.getKeys({ url })` |

`"strict": true` (`ts/tsconfig.json:18`) is the project's contract and nothing enforces it —
Bun transpiles without typechecking, so the code runs while the type layer is red. It also
hides the real defect: a missing env var becomes `undefined` at runtime and fails opaquely
inside the SDK.

Status: **found, fix in progress** — a parallel change validates the three env vars at
startup and narrows them to `string`. Only confirm `tsc --noEmit` is clean once it lands.

### 2. Medium — no error handling around any top-level `await`

`ts/wallets.ts:3`, `:9` and `:12` are unguarded top-level awaits over network and crypto
work. Unreachable host, 404, malformed key or clock skew on the HTTP signature all surface
as an unhandled rejection with a raw SDK stack trace and no hint which env var is at fault.
Sharper edge: `Buffer.from(value, "base64")` (`ts/wallets.ts:5`) does not throw on bad input,
it silently drops invalid characters — a truncated `PRIVATE_KEY` yields a garbage key and a
confusing signature error later instead of "PRIVATE_KEY is not valid base64".

Fix: move the body into `async function main()` with `try/catch`, log a scoped message per
stage, `process.exit(1)` on failure, and assert the decoded key starts with `-----BEGIN`.

### 3. Medium — `.gitignore` only protects the `ts/` subtree

`ts/.gitignore:19` correctly ignores `.env`, and `ts/.env.example:1-3` lists the three
variables with empty values — both good. But the file sits at `ts/.gitignore`, so its
patterns are rooted at `ts/`, and there is **no repository-root `.gitignore`**. A `.env` at
the repo root — normal once a second language directory joins `ts/` — is not ignored and
will be offered for commit.

Same file, separate defect: `ts/.gitignore:15` reads `_.log` and `:16` reads
`report.[0-9]_.[0-9]_.[0-9]_.[0-9]_.json`; the `bun init` defaults are `*.log` and
`report.[0-9]*…`. The globs are mangled, so **no `.log` file is ignored** — and this
program's entire output is `console.log`, one `> run.log` away from the index.
`ts/.gitignore:37` (`.CLAUDE.md`, leading dot) matches nothing; the tracked file is `CLAUDE.md`.

Fix: add a root `.gitignore` with `.env`, `.env.*`, `!.env.example`, `node_modules`; repair
the `*.log` and `report.*` globs.

### 4. Low — full API responses logged verbatim

`ts/wallets.ts:16-17` dumps both responses. Today this leaks nothing: the wallet address
resource and the JWK set are public data from open endpoints, and the private key is never
logged. The concern is the habit — this process holds a decoded private key
(`ts/wallets.ts:5`), and "log the whole response" is what leaks the first time it points at a
grant or token response carrying `access_token.value`. With finding 3's broken `*.log` glob,
that output is committable. Fix: log selected fields (`walletAddress.id`, `assetCode`,
`keys.length`), never anything derived from `PRIVATE_KEY`.

### 5. Medium — dead entry point, and `package.json` points at it

`ts/index.ts:1` is a stub while all logic lives in `ts/wallets.ts`. `ts/package.json:3`
declares `"module": "index.ts"`, so the advertised entry point is the stub, and
`ts/README.md:12` tells readers to run exactly that — a new contributor sees `Test` and
learns nothing. Fix: delete `ts/index.ts` and point `"module"` at `wallets.ts`, or make
`index.ts` the real entry that calls an exported function from `wallets.ts`.

### 6. Medium — no `scripts` block in `package.json`

`ts/package.json:1-15` has dependencies but no `"scripts"`: no `typecheck` (which is why
finding 1 went unnoticed), no `start`, no `test`. It also contradicts `ts/CLAUDE.md:14`,
which prescribes `bun run <script>` — there are none. Fix:
`"scripts": { "start": "bun wallets.ts", "typecheck": "tsc --noEmit", "test": "bun test" }`.

### 7. Medium — no tests, despite `CLAUDE.md` prescribing `bun test`

`ts/CLAUDE.md:10` and its Testing section mandate `bun test` and supply a template; the repo
has zero `*.test.ts` files. The env-var validation arriving with the finding-1 fix is pure,
dependency-free logic — exactly what to cover first. Fix: extract `buildClient(env)` taking a
plain object so the network stays out of tests, then add `wallets.test.ts` for missing env
vars and non-base64 `PRIVATE_KEY`.

### 8. Medium — `README.md` is untouched `bun init` boilerplate

`ts/README.md:1-15` says nothing about Interledger, Open Payments, what the program does, or
the three required environment variables; it documents a run command that executes the dead
stub and closes with the generated "created using `bun init`" line. Fix: state the purpose,
the prerequisites (wallet address, key uploaded to the provider, its key ID), the
`cp .env.example .env` step with one line per variable, and the real run command.

### 9. Low — `.env.example` does not state expected encodings

`ts/.env.example:3` gives `PRIVATE_KEY=` with no hint that it must be the base64 encoding of
a PEM key — discoverable only by reading `ts/wallets.ts:5`. `WALLET_ADDRESS` must be a full
`https://…` URL, since it is used both as `walletAddressUrl` and as a fetch `url`
(`ts/wallets.ts:4`, `:10`). Fix: a `#` comment above each variable with format and sample.

### 10. Low — loose dependency specifiers

`ts/package.json:7` pins `@types/bun` to `"latest"`, not a reproducible range;
`ts/package.json:10` declares `typescript` as a `peerDependency` of a `private` leaf
application, where it belongs in `devDependencies`. `bun.lock` is committed so builds are
reproducible in practice, but a lockfile refresh can silently move the type definitions.
Both are `bun init` defaults rather than deliberate choices.

## Strengths

- `ts/tsconfig.json:18-22` is genuinely strict — `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`. Finding 1 exists *because* the bar is
  set correctly.
- One runtime dependency, on a caret range over a known-good major (`ts/package.json:13`),
  with `bun.lock` committed.
- Secrets come from the environment, not source; `.env` is gitignored (`ts/.gitignore:19`)
  and `.env.example` lists the full variable set.
- `ts/CLAUDE.md` documents the Bun-first conventions concretely, testing included — the gap
  is compliance, not guidance.
- `wallets.ts` is small, linear, and free of premature abstraction.

## Recommended next steps

1. Land the in-flight env-var validation fix; confirm `tsc --noEmit` reports 0 errors (1).
2. Add the `scripts` block — `start`, `typecheck`, `test` (6). Without `typecheck`, step 1
   regresses.
3. Add a root `.gitignore` for `.env` / `.env.*`, and repair the `_.log` and `report.*`
   globs (3).
4. Wrap `wallets.ts` in `main()` with `try/catch`, non-zero exit, and a PEM sanity check on
   the decoded key (2).
5. Resolve the entry point: delete or repurpose `ts/index.ts`, update `"module"` (5).
6. Extract `buildClient(env)` and add `wallets.test.ts` for missing/malformed env vars (7).
7. Rewrite `ts/README.md`; annotate `.env.example` with formats (8, 9).
8. Narrow the `console.log`s before pointing the code at grant or token endpoints (4).
9. Tidy `package.json` dependency specifiers (10).
