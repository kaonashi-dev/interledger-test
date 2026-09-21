/**
 * Simulates the COMPLETE Interledger Open Payments payment workflow, end to end.
 *
 *   1. Fetch the sender and receiver wallet addresses.
 *   2. Request a non-interactive `incoming-payment` grant on the RECEIVER's auth server.
 *   3. Create an incoming payment on the RECEIVER's resource server.
 *   4. Request a non-interactive `quote` grant on the SENDER's auth server.
 *   5. Create a quote on the SENDER's resource server.
 *   6. Request an INTERACTIVE `outgoing-payment` grant, wait for the user to
 *      approve it in the browser, then continue the grant with `interact_ref`.
 *   7. Create the outgoing payment and poll it until the funds have been sent.
 *
 * Usage:
 *   bun run simulate-payment.ts                 # live, needs credentials in .env
 *   bun run simulate-payment.ts --dry-run       # offline, stubbed, no credentials
 *   bun run simulate-payment.ts --amount=2500   # amount in minor units
 */

import {
  createAuthenticatedClient,
  isFinalizedGrant,
  isPendingGrant,
  OpenPaymentsClientError,
} from "@interledger/open-payments";
import type {
  Grant,
  GrantContinuation,
  GrantRequest,
  IncomingPaymentWithPaymentMethods,
  OutgoingPayment,
  OutgoingPaymentWithSpentAmounts,
  PendingGrant,
  Quote,
  WalletAddress,
} from "@interledger/open-payments";

import { clientArgs, envOrDefault, loadConfig, optionalEnv } from "./config.ts";

// ---------------------------------------------------------------------------
// Types derived from the SDK (the create-arg types are not exported directly,
// so they are read off the client's own signatures — no hand written shapes).
// ---------------------------------------------------------------------------

type AuthenticatedClient = Awaited<
  ReturnType<typeof createAuthenticatedClient>
>;
type CreateIncomingPaymentArgs = Parameters<
  AuthenticatedClient["incomingPayment"]["create"]
>[1];
type CreateQuoteArgs = Parameters<AuthenticatedClient["quote"]["create"]>[1];
type CreateOutgoingPaymentArgs = Parameters<
  AuthenticatedClient["outgoingPayment"]["create"]
>[1];

type GrantAccess = GrantRequest["access_token"]["access"];
type GrantInteract = NonNullable<GrantRequest["interact"]>;
type Amount = Quote["debitAmount"];

interface ResourceTarget {
  /** Resource server (for creates) or full resource URL (for reads). */
  readonly url: string;
  readonly accessToken: string;
}

/**
 * The narrow slice of Open Payments the simulator needs. Implemented twice:
 * once against the real SDK, once against in-memory stubs for `--dry-run`.
 */
interface PaymentsBackend {
  readonly mode: "live" | "dry-run";
  /** Milliseconds to wait between outgoing-payment polls. */
  readonly pollIntervalMs: number;
  getWalletAddress(url: string): Promise<WalletAddress>;
  requestGrant(
    authServerUrl: string,
    request: { access_token: { access: GrantAccess }; interact?: GrantInteract },
  ): Promise<PendingGrant | Grant>;
  continueGrant(args: {
    continueUri: string;
    continueAccessToken: string;
    interactRef: string;
  }): Promise<Grant | GrantContinuation>;
  createIncomingPayment(
    target: ResourceTarget,
    args: CreateIncomingPaymentArgs,
  ): Promise<IncomingPaymentWithPaymentMethods>;
  createQuote(target: ResourceTarget, args: CreateQuoteArgs): Promise<Quote>;
  createOutgoingPayment(
    target: ResourceTarget,
    args: CreateOutgoingPaymentArgs,
  ): Promise<OutgoingPaymentWithSpentAmounts>;
  getOutgoingPayment(target: ResourceTarget): Promise<OutgoingPayment>;
  /** Shows the redirect URL and resolves with the `interact_ref`. */
  collectInteractRef(redirectUrl: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  readonly dryRun: boolean;
  readonly amountMinorUnits: bigint;
  readonly help: boolean;
}

const DEFAULT_AMOUNT_MINOR_UNITS = 1000n;
const MAX_POLL_ATTEMPTS = 10;
const LIVE_POLL_INTERVAL_MS = 1500;

const USAGE = `
Simulate the full Interledger Open Payments workflow.

  bun run simulate-payment.ts [options]

Options:
  --dry-run              Walk all 7 steps with stubbed responses. No network
                         calls, no credentials, interaction auto-approved.
  --amount=<minorUnits>  Amount to send in minor units (default: ${DEFAULT_AMOUNT_MINOR_UNITS}).
                         With assetScale 2, 1000 means 10.00.
  --help, -h             Show this message.
`.trim();

function parseOptions(argv: readonly string[]): Options {
  let dryRun = false;
  let help = false;
  let amountMinorUnits = DEFAULT_AMOUNT_MINOR_UNITS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg.startsWith("--amount=")) {
      amountMinorUnits = parseAmount(arg.slice("--amount=".length));
    } else if (arg === "--amount") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--amount requires a value, e.g. --amount=1000");
      }
      amountMinorUnits = parseAmount(next);
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return { dryRun, amountMinorUnits, help };
}

function parseAmount(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid --amount "${raw}": expected a positive integer in minor units (e.g. 1000 for 10.00 at assetScale 2).`,
    );
  }
  const value = BigInt(raw);
  if (value <= 0n) {
    throw new Error(`Invalid --amount "${raw}": must be greater than zero.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Console formatting
// ---------------------------------------------------------------------------

const RULE = "=".repeat(74);
const TOTAL_STEPS = 7;

function banner(title: string, subtitle: string): void {
  console.log(`\n${RULE}`);
  console.log(title);
  console.log(subtitle);
  console.log(RULE);
}

function step(n: number, title: string, detail: string): void {
  console.log(`\n${"-".repeat(74)}`);
  console.log(`STEP ${n}/${TOTAL_STEPS}  ${title}`);
  console.log(`         ${detail}`);
  console.log("-".repeat(74));
}

function field(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

function note(text: string): void {
  console.log(`  > ${text}`);
}

/** "10.00 USD (value=1000, assetScale=2)" */
function formatAmount(amount: Amount): string {
  const scale = amount.assetScale;
  const raw = BigInt(amount.value);
  const divisor = 10n ** BigInt(scale);
  const whole = raw / divisor;
  const fraction = (raw % divisor).toString().padStart(scale, "0");
  const decimal = scale > 0 ? `${whole}.${fraction}` : whole.toString();
  return `${decimal} ${amount.assetCode} (value=${amount.value}, assetScale=${scale})`;
}

function truncate(value: string, max = 48): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

// ---------------------------------------------------------------------------
// Live backend
// ---------------------------------------------------------------------------

class LiveBackend implements PaymentsBackend {
  readonly mode = "live" as const;
  readonly pollIntervalMs = LIVE_POLL_INTERVAL_MS;

  constructor(private readonly client: AuthenticatedClient) {}

  getWalletAddress(url: string): Promise<WalletAddress> {
    return this.client.walletAddress.get({ url });
  }

  requestGrant(
    authServerUrl: string,
    request: { access_token: { access: GrantAccess }; interact?: GrantInteract },
  ): Promise<PendingGrant | Grant> {
    return this.client.grant.request({ url: authServerUrl }, request);
  }

  continueGrant(args: {
    continueUri: string;
    continueAccessToken: string;
    interactRef: string;
  }): Promise<Grant | GrantContinuation> {
    return this.client.grant.continue(
      { url: args.continueUri, accessToken: args.continueAccessToken },
      { interact_ref: args.interactRef },
    );
  }

  createIncomingPayment(
    target: ResourceTarget,
    args: CreateIncomingPaymentArgs,
  ): Promise<IncomingPaymentWithPaymentMethods> {
    return this.client.incomingPayment.create(target, args);
  }

  createQuote(target: ResourceTarget, args: CreateQuoteArgs): Promise<Quote> {
    return this.client.quote.create(target, args);
  }

  createOutgoingPayment(
    target: ResourceTarget,
    args: CreateOutgoingPaymentArgs,
  ): Promise<OutgoingPaymentWithSpentAmounts> {
    return this.client.outgoingPayment.create(target, args);
  }

  getOutgoingPayment(target: ResourceTarget): Promise<OutgoingPayment> {
    return this.client.outgoingPayment.get(target);
  }

  async collectInteractRef(redirectUrl: string): Promise<string> {
    console.log("");
    note("Open this URL in a browser and approve the payment:");
    console.log(`\n    ${redirectUrl}\n`);
    note(
      "After approving you will be redirected to your INTERACT_REDIRECT_URI with",
    );
    note("an `interact_ref` query parameter. Paste that value below.");

    await Bun.write(Bun.stdout, "\n  interact_ref: ");

    for await (const line of console) {
      const trimmed = line.trim();
      if (trimmed.length > 0) return extractInteractRef(trimmed);
      await Bun.write(Bun.stdout, "  interact_ref: ");
    }

    throw new Error(
      "stdin closed before an interact_ref was provided. Run the script in an interactive terminal, or use --dry-run.",
    );
  }
}

/** Accepts either a bare interact_ref or the whole redirect URL. */
function extractInteractRef(input: string): string {
  if (!input.includes("://")) return input;
  try {
    const parsed = new URL(input);
    const ref = parsed.searchParams.get("interact_ref");
    if (ref === null) {
      throw new Error(
        `The URL "${truncate(input)}" has no interact_ref query parameter.`,
      );
    }
    return ref;
  } catch (error) {
    if (error instanceof TypeError) return input;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dry-run backend: realistic stubs, zero network, zero credentials
// ---------------------------------------------------------------------------

const STUB_AUTH_SERVER = "https://auth.interledger-test.dev";
const STUB_RESOURCE_SERVER = "https://ilp.interledger-test.dev";

class DryRunBackend implements PaymentsBackend {
  readonly mode = "dry-run" as const;
  readonly pollIntervalMs = 0;

  private readonly incomingPayments = new Map<
    string,
    IncomingPaymentWithPaymentMethods
  >();
  private readonly quotes = new Map<string, Quote>();
  private readonly outgoingPayments = new Map<string, OutgoingPayment>();
  private readonly pollCounts = new Map<string, number>();
  private counter = 0;

  private nextId(prefix: string): string {
    this.counter++;
    return `${prefix}-${this.counter.toString().padStart(4, "0")}-b3a1f7c2`;
  }

  async getWalletAddress(url: string): Promise<WalletAddress> {
    const name = url.split("/").filter(Boolean).at(-1) ?? "wallet";
    return {
      id: url,
      publicName: name.charAt(0).toUpperCase() + name.slice(1),
      assetCode: "USD",
      assetScale: 2,
      authServer: STUB_AUTH_SERVER,
      resourceServer: STUB_RESOURCE_SERVER,
    };
  }

  async requestGrant(
    authServerUrl: string,
    request: { access_token: { access: GrantAccess }; interact?: GrantInteract },
  ): Promise<PendingGrant | Grant> {
    const continueId = this.nextId("continue");
    const continuation = {
      access_token: { value: `continue-token-${continueId}` },
      uri: `${authServerUrl}/continue/${continueId}`,
      wait: 0,
    };

    if (request.interact !== undefined) {
      return {
        interact: {
          redirect: `${authServerUrl}/interact/${continueId}/${this.nextId("nonce")}`,
          finish: `finish-${continueId}`,
        },
        continue: continuation,
      };
    }

    return {
      access_token: {
        value: `access-token-${this.nextId("tok")}`,
        manage: `${authServerUrl}/token/${this.nextId("mng")}`,
        expires_in: 600,
        access: request.access_token.access,
      },
      continue: continuation,
    };
  }

  async continueGrant(args: {
    continueUri: string;
    continueAccessToken: string;
    interactRef: string;
  }): Promise<Grant | GrantContinuation> {
    return {
      access_token: {
        value: `access-token-${this.nextId("tok")}`,
        manage: `${STUB_AUTH_SERVER}/token/${this.nextId("mng")}`,
        expires_in: 600,
        access: [
          {
            type: "outgoing-payment",
            actions: ["create", "read"],
            identifier: `${STUB_RESOURCE_SERVER}/alice`,
          },
        ],
      },
      continue: {
        access_token: { value: args.continueAccessToken },
        uri: args.continueUri,
        wait: 0,
      },
    };
  }

  async createIncomingPayment(
    target: ResourceTarget,
    args: CreateIncomingPaymentArgs,
  ): Promise<IncomingPaymentWithPaymentMethods> {
    const incomingAmount = args.incomingAmount;
    if (incomingAmount === undefined) {
      throw new Error("Dry run expects an incomingAmount on the incoming payment.");
    }

    const payment: IncomingPaymentWithPaymentMethods = {
      id: `${target.url}/incoming-payments/${this.nextId("ip")}`,
      walletAddress: args.walletAddress,
      completed: false,
      incomingAmount,
      receivedAmount: zeroLike(incomingAmount),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
      methods: [
        {
          type: "ilp",
          ilpAddress: "g.interledger-test.receiver.7d3f9c1a",
          sharedSecret: "Pcz2yKZ1V3gh4hGjQ0mRk5rNpF8wXbLdT6sE9uYcA1o",
        },
      ],
    };

    this.incomingPayments.set(payment.id, payment);
    return payment;
  }

  async createQuote(
    target: ResourceTarget,
    args: CreateQuoteArgs,
  ): Promise<Quote> {
    const incomingPayment = this.incomingPayments.get(args.receiver);
    const receiveAmount =
      incomingPayment?.incomingAmount ??
      args.receiveAmount ??
      args.debitAmount ?? {
        value: "1000",
        assetCode: "USD",
        assetScale: 2,
      };

    // A realistic sender-side spread: 1% network fee, rounded up.
    const receiveValue = BigInt(receiveAmount.value);
    const fee = (receiveValue + 99n) / 100n;

    const quote: Quote = {
      id: `${target.url}/quotes/${this.nextId("qt")}`,
      walletAddress: args.walletAddress,
      receiver: args.receiver,
      receiveAmount,
      debitAmount: {
        value: (receiveValue + fee).toString(),
        assetCode: receiveAmount.assetCode,
        assetScale: receiveAmount.assetScale,
      },
      method: args.method,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    this.quotes.set(quote.id, quote);
    return quote;
  }

  async createOutgoingPayment(
    target: ResourceTarget,
    args: CreateOutgoingPaymentArgs,
  ): Promise<OutgoingPaymentWithSpentAmounts> {
    if (!("quoteId" in args)) {
      throw new Error("Dry run expects the outgoing payment to be created from a quote.");
    }

    const quote = this.quotes.get(args.quoteId);
    if (quote === undefined) {
      throw new Error(`Dry run has no stubbed quote with id ${args.quoteId}.`);
    }

    const payment: OutgoingPayment = {
      id: `${target.url}/outgoing-payments/${this.nextId("op")}`,
      walletAddress: args.walletAddress,
      quoteId: quote.id,
      failed: false,
      receiver: quote.receiver,
      receiveAmount: quote.receiveAmount,
      debitAmount: quote.debitAmount,
      sentAmount: zeroLike(quote.debitAmount),
      metadata: args.metadata,
      createdAt: new Date().toISOString(),
    };

    this.outgoingPayments.set(payment.id, payment);
    this.pollCounts.set(payment.id, 0);

    return {
      ...payment,
      grantSpentDebitAmount: zeroLike(quote.debitAmount),
      grantSpentReceiveAmount: zeroLike(quote.receiveAmount),
    };
  }

  async getOutgoingPayment(target: ResourceTarget): Promise<OutgoingPayment> {
    const payment = this.outgoingPayments.get(target.url);
    if (payment === undefined) {
      throw new Error(`Dry run has no stubbed outgoing payment at ${target.url}.`);
    }

    // Each read advances the simulated ILP delivery: half, then everything.
    const polls = (this.pollCounts.get(target.url) ?? 0) + 1;
    this.pollCounts.set(target.url, polls);

    const debit = BigInt(payment.debitAmount.value);
    const sent = polls >= 2 ? debit : debit / 2n;

    const updated: OutgoingPayment = {
      ...payment,
      sentAmount: { ...payment.debitAmount, value: sent.toString() },
    };
    this.outgoingPayments.set(target.url, updated);
    return updated;
  }

  async collectInteractRef(redirectUrl: string): Promise<string> {
    console.log("");
    note("Interaction URL the user would open in a browser:");
    console.log(`\n    ${redirectUrl}\n`);
    note("Dry run: interaction auto-approved, no browser and no stdin needed.");
    return this.nextId("interact-ref");
  }
}

function zeroLike(amount: Amount): Amount {
  return { value: "0", assetCode: amount.assetCode, assetScale: amount.assetScale };
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

interface SimulationInputs {
  readonly senderWalletAddressUrl: string;
  readonly receiverWalletAddressUrl: string;
  readonly interactRedirectUri: string;
}

async function simulate(
  backend: PaymentsBackend,
  inputs: SimulationInputs,
  amountMinorUnits: bigint,
): Promise<void> {
  banner(
    `Open Payments end-to-end simulation  [${backend.mode.toUpperCase()}]`,
    `sender: ${inputs.senderWalletAddressUrl}  ->  receiver: ${inputs.receiverWalletAddressUrl}`,
  );

  // --- Step 1 ---------------------------------------------------------------
  step(1, "Wallet addresses", "public GET on both wallet addresses");

  const [senderWalletAddress, receiverWalletAddress] = await Promise.all([
    backend.getWalletAddress(inputs.senderWalletAddressUrl),
    backend.getWalletAddress(inputs.receiverWalletAddressUrl),
  ]);

  console.log("  SENDER");
  field("id", senderWalletAddress.id);
  field("asset", `${senderWalletAddress.assetCode} (scale ${senderWalletAddress.assetScale})`);
  field("authServer", senderWalletAddress.authServer);
  field("resourceServer", senderWalletAddress.resourceServer);
  console.log("  RECEIVER");
  field("id", receiverWalletAddress.id);
  field("asset", `${receiverWalletAddress.assetCode} (scale ${receiverWalletAddress.assetScale})`);
  field("authServer", receiverWalletAddress.authServer);
  field("resourceServer", receiverWalletAddress.resourceServer);

  const incomingAmount: Amount = {
    value: amountMinorUnits.toString(),
    assetCode: receiverWalletAddress.assetCode,
    assetScale: receiverWalletAddress.assetScale,
  };
  note(`Requested transfer: ${formatAmount(incomingAmount)}`);

  // --- Step 2 ---------------------------------------------------------------
  step(
    2,
    "Incoming-payment grant",
    `non-interactive grant on the RECEIVER auth server (${receiverWalletAddress.authServer})`,
  );

  const incomingGrant = requireNonInteractiveGrant(
    await backend.requestGrant(receiverWalletAddress.authServer, {
      access_token: {
        access: [
          {
            type: "incoming-payment",
            actions: ["create", "read", "complete"],
          },
        ],
      },
    }),
    "incoming-payment",
  );

  field("access token", truncate(incomingGrant.access_token.value));
  field("manage url", incomingGrant.access_token.manage);
  field("expires in", `${incomingGrant.access_token.expires_in ?? "n/a"} s`);
  field("granted access", describeAccess(incomingGrant.access_token.access));

  // --- Step 3 ---------------------------------------------------------------
  step(
    3,
    "Create incoming payment",
    `POST ${receiverWalletAddress.resourceServer}/incoming-payments`,
  );

  const incomingPayment = await backend.createIncomingPayment(
    {
      url: receiverWalletAddress.resourceServer,
      accessToken: incomingGrant.access_token.value,
    },
    {
      walletAddress: receiverWalletAddress.id,
      incomingAmount,
      metadata: { description: "Open Payments end-to-end simulation" },
    },
  );

  field("id", incomingPayment.id);
  field("walletAddress", incomingPayment.walletAddress);
  field(
    "incomingAmount",
    incomingPayment.incomingAmount === undefined
      ? "n/a"
      : formatAmount(incomingPayment.incomingAmount),
  );
  field("receivedAmount", formatAmount(incomingPayment.receivedAmount));
  field("completed", String(incomingPayment.completed));
  field("expiresAt", incomingPayment.expiresAt ?? "n/a");
  field(
    "payment methods",
    incomingPayment.methods.map((method) => method.type).join(", ") || "none",
  );

  // --- Step 4 ---------------------------------------------------------------
  step(
    4,
    "Quote grant",
    `non-interactive grant on the SENDER auth server (${senderWalletAddress.authServer})`,
  );

  const quoteGrant = requireNonInteractiveGrant(
    await backend.requestGrant(senderWalletAddress.authServer, {
      access_token: {
        access: [{ type: "quote", actions: ["create", "read"] }],
      },
    }),
    "quote",
  );

  field("access token", truncate(quoteGrant.access_token.value));
  field("manage url", quoteGrant.access_token.manage);
  field("granted access", describeAccess(quoteGrant.access_token.access));

  // --- Step 5 ---------------------------------------------------------------
  step(5, "Create quote", `POST ${senderWalletAddress.resourceServer}/quotes`);

  const quote = await backend.createQuote(
    {
      url: senderWalletAddress.resourceServer,
      accessToken: quoteGrant.access_token.value,
    },
    {
      walletAddress: senderWalletAddress.id,
      receiver: incomingPayment.id,
      method: "ilp",
    },
  );

  field("id", quote.id);
  field("receiver", quote.receiver);
  field("receiveAmount", formatAmount(quote.receiveAmount));
  field("debitAmount", formatAmount(quote.debitAmount));
  field("method", quote.method);
  field("expiresAt", quote.expiresAt ?? "n/a");
  note(
    `Sender pays ${formatAmount(quote.debitAmount)} so the receiver gets ${formatAmount(quote.receiveAmount)}.`,
  );

  // --- Step 6 ---------------------------------------------------------------
  step(
    6,
    "Outgoing-payment grant (INTERACTIVE)",
    "the account holder must approve this one in a browser",
  );

  const outgoingGrantRequest = await backend.requestGrant(
    senderWalletAddress.authServer,
    {
      access_token: {
        access: [
          {
            type: "outgoing-payment",
            actions: ["create", "read"],
            identifier: senderWalletAddress.id,
            limits: { debitAmount: quote.debitAmount },
          },
        ],
      },
      interact: {
        start: ["redirect"],
        finish: {
          method: "redirect",
          uri: inputs.interactRedirectUri,
          nonce: crypto.randomUUID(),
        },
      },
    },
  );

  if (!isPendingGrant(outgoingGrantRequest)) {
    throw new Error(
      "Expected a pending (interactive) grant for the outgoing payment, but the auth server finalized it immediately.",
    );
  }

  field("interact redirect", truncate(outgoingGrantRequest.interact.redirect, 60));
  field("interact finish", outgoingGrantRequest.interact.finish);
  field("continue uri", outgoingGrantRequest.continue.uri);
  field("continue wait", `${outgoingGrantRequest.continue.wait ?? 0} s`);
  field("limits.debitAmount", formatAmount(quote.debitAmount));

  const interactRef = await backend.collectInteractRef(
    outgoingGrantRequest.interact.redirect,
  );
  note(`interact_ref = ${interactRef}`);

  const waitSeconds = outgoingGrantRequest.continue.wait ?? 0;
  if (backend.mode === "live" && waitSeconds > 0) {
    note(`Waiting ${waitSeconds}s before continuing, as the auth server asked.`);
    await Bun.sleep(waitSeconds * 1000);
  }

  const continued = await backend.continueGrant({
    continueUri: outgoingGrantRequest.continue.uri,
    continueAccessToken: outgoingGrantRequest.continue.access_token.value,
    interactRef,
  });

  if (!isFinalizedGrant(continued)) {
    throw new Error(
      "The grant is still pending after continuing it. The interaction was probably not completed.",
    );
  }

  field("access token", truncate(continued.access_token.value));
  field("manage url", continued.access_token.manage);
  field("granted access", describeAccess(continued.access_token.access));

  // --- Step 7 ---------------------------------------------------------------
  step(
    7,
    "Create outgoing payment",
    `POST ${senderWalletAddress.resourceServer}/outgoing-payments, then poll it`,
  );

  const outgoingPayment = await backend.createOutgoingPayment(
    {
      url: senderWalletAddress.resourceServer,
      accessToken: continued.access_token.value,
    },
    {
      walletAddress: senderWalletAddress.id,
      quoteId: quote.id,
      metadata: { description: "Open Payments end-to-end simulation" },
    },
  );

  field("id", outgoingPayment.id);
  field("quoteId", outgoingPayment.quoteId ?? "n/a");
  field("receiver", outgoingPayment.receiver);
  field("debitAmount", formatAmount(outgoingPayment.debitAmount));
  field("receiveAmount", formatAmount(outgoingPayment.receiveAmount));
  field("sentAmount", formatAmount(outgoingPayment.sentAmount));
  field("failed", String(outgoingPayment.failed));

  const settled = await pollOutgoingPayment(backend, {
    url: outgoingPayment.id,
    accessToken: continued.access_token.value,
  });

  // --- Summary --------------------------------------------------------------
  banner(
    `RESULT  [${backend.mode.toUpperCase()}]`,
    settled.failed
      ? "The outgoing payment FAILED."
      : BigInt(settled.sentAmount.value) >= BigInt(settled.debitAmount.value)
        ? "The payment was sent in full."
        : "The payment is still in flight (polling budget exhausted).",
  );
  field("outgoing payment", settled.id);
  field("incoming payment", incomingPayment.id);
  field("sentAmount", formatAmount(settled.sentAmount));
  field("receiveAmount", formatAmount(settled.receiveAmount));
  field("debitAmount", formatAmount(settled.debitAmount));
  field("failed", String(settled.failed));
  console.log("");
}

async function pollOutgoingPayment(
  backend: PaymentsBackend,
  target: ResourceTarget,
): Promise<OutgoingPayment> {
  let latest: OutgoingPayment | undefined;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    if (attempt > 1 && backend.pollIntervalMs > 0) {
      await Bun.sleep(backend.pollIntervalMs);
    }

    latest = await backend.getOutgoingPayment(target);
    console.log(
      `  poll ${attempt}/${MAX_POLL_ATTEMPTS}: sentAmount=${latest.sentAmount.value}/${latest.debitAmount.value} failed=${latest.failed}`,
    );

    if (latest.failed) break;
    if (BigInt(latest.sentAmount.value) >= BigInt(latest.debitAmount.value)) {
      break;
    }
  }

  if (latest === undefined) {
    throw new Error("Outgoing payment could not be read back after creation.");
  }
  return latest;
}

/** Narrows a grant response, failing loudly if the AS wants interaction. */
function requireNonInteractiveGrant(
  grant: PendingGrant | Grant,
  label: string,
): Grant {
  if (isPendingGrant(grant)) {
    throw new Error(
      `The ${label} grant unexpectedly requires interaction (redirect: ${grant.interact.redirect}). Only outgoing-payment grants should be interactive.`,
    );
  }
  return grant;
}

function describeAccess(access: GrantAccess): string {
  return access
    .map((item) => `${item.type}[${item.actions.join(", ")}]`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function buildBackend(
  options: Options,
): Promise<{ backend: PaymentsBackend; inputs: SimulationInputs }> {
  if (options.dryRun) {
    // No credentials required: env vars are used only if they happen to be set,
    // purely so the printed URLs match the user's own setup.
    return {
      backend: new DryRunBackend(),
      inputs: {
        senderWalletAddressUrl: envOrDefault(
          "SENDER_WALLET_ADDRESS",
          optionalEnv("WALLET_ADDRESS") ?? `${STUB_RESOURCE_SERVER}/alice`,
        ),
        receiverWalletAddressUrl: envOrDefault(
          "RECEIVER_WALLET_ADDRESS",
          `${STUB_RESOURCE_SERVER}/bob`,
        ),
        interactRedirectUri: envOrDefault(
          "INTERACT_REDIRECT_URI",
          "http://localhost:3344/callback",
        ),
      },
    };
  }

  const config = loadConfig();
  const client = await createAuthenticatedClient(clientArgs(config));

  return {
    backend: new LiveBackend(client),
    inputs: {
      senderWalletAddressUrl: config.senderWalletAddressUrl,
      receiverWalletAddressUrl: config.receiverWalletAddressUrl,
      interactRedirectUri: config.interactRedirectUri,
    },
  };
}

function reportError(error: unknown): void {
  console.error("\n" + RULE);
  console.error("SIMULATION FAILED");
  console.error(RULE);

  if (error instanceof OpenPaymentsClientError) {
    console.error(`  Open Payments client error: ${error.message}`);
    console.error(`  description:       ${error.description}`);
    if (error.status !== undefined) console.error(`  status:            ${error.status}`);
    if (error.code !== undefined) console.error(`  code:              ${error.code}`);
    if (error.validationErrors !== undefined && error.validationErrors.length > 0) {
      console.error("  validationErrors:");
      for (const validationError of error.validationErrors) {
        console.error(`    - ${validationError}`);
      }
    }
    if (error.details !== undefined) {
      console.error(`  details:           ${JSON.stringify(error.details)}`);
    }
  } else if (error instanceof Error) {
    console.error(`  ${error.message}`);
  } else {
    console.error(`  ${String(error)}`);
  }

  console.error("");
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(Bun.argv.slice(2));
  } catch (error) {
    reportError(error);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const { backend, inputs } = await buildBackend(options);
    await simulate(backend, inputs, options.amountMinorUnits);
    return 0;
  } catch (error) {
    reportError(error);
    return 1;
  }
}

process.exitCode = await main();
