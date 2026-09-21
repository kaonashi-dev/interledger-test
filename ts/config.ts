/**
 * Typed configuration boundary for the Open Payments scripts.
 *
 * Every environment variable is read through here so that the rest of the code
 * never has to deal with `string | undefined`. Bun loads `.env` automatically,
 * so there is no `dotenv` dependency.
 *
 * Nothing in this module runs at import time: the loaders are functions, which
 * means a script can be started without any credentials at all (for example
 * `simulate-payment.ts --dry-run`).
 */

/** Human readable hints shown when a variable is missing. */
const ENV_HINTS: Readonly<Record<string, string>> = {
  SENDER_WALLET_ADDRESS:
    "The wallet address URL the payment is sent FROM, e.g. https://ilp.interledger-test.dev/alice",
  RECEIVER_WALLET_ADDRESS:
    "The wallet address URL the payment is sent TO, e.g. https://ilp.interledger-test.dev/bob",
  KEY_ID:
    "The key id (kid) of the public key registered on the sender's wallet address",
  PRIVATE_KEY:
    "The base64 encoding of your Ed25519 private key PEM file, e.g. `base64 -i private.key | pbcopy`",
};

/**
 * Reads a required environment variable, throwing an actionable error when it
 * is missing or blank.
 */
export function requireEnv(name: string): string {
  const value = Bun.env[name];

  if (value === undefined || value.trim() === "") {
    const hint = ENV_HINTS[name];
    throw new Error(
      [
        `Missing required environment variable: ${name}`,
        hint ? `  What it is: ${hint}` : undefined,
        `  Fix: add \`${name}=...\` to ts/.env (see ts/.env.example for the full list).`,
        `  Bun loads ts/.env automatically — no dotenv needed.`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    );
  }

  return value.trim();
}

/**
 * Reads an optional environment variable. Blank values are treated as unset so
 * that a stub line such as `KEY_ID=` in `.env` does not count as configured.
 */
export function optionalEnv(name: string): string | undefined {
  const value = Bun.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

/**
 * Reads an optional environment variable, falling back to `fallback` when it is
 * not set.
 */
export function envOrDefault(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback;
}

/**
 * Reads the first of `names` that is set, and throws naming all of them when
 * none is. Used so that the historical `WALLET_ADDRESS` keeps working as an
 * alias for `SENDER_WALLET_ADDRESS`.
 */
export function requireOneOfEnv(...names: readonly string[]): string {
  for (const name of names) {
    const value = optionalEnv(name);
    if (value !== undefined) return value;
  }

  const [primary = "UNKNOWN", ...aliases] = names;
  const hint = ENV_HINTS[primary];
  throw new Error(
    [
      `Missing required environment variable: ${primary}`,
      hint ? `  What it is: ${hint}` : undefined,
      aliases.length > 0
        ? `  Accepted aliases: ${aliases.join(", ")}`
        : undefined,
      `  Fix: add \`${primary}=...\` to ts/.env (see ts/.env.example for the full list).`,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
}

/**
 * Decodes `PRIVATE_KEY` (the base64 encoding of an Ed25519 private key PEM
 * file) into the PEM text that the Open Payments client expects.
 */
export function getPrivateKey(): string {
  const encoded = requireEnv("PRIVATE_KEY");
  const pem = Buffer.from(encoded, "base64").toString("utf-8");

  if (!pem.includes("-----BEGIN")) {
    throw new Error(
      [
        "PRIVATE_KEY did not decode to a PEM formatted private key.",
        "  It must be the BASE64 encoding of the whole .key/.pem file, not the PEM text itself.",
        "  Generate it with: base64 -i private.key",
      ].join("\n"),
    );
  }

  return pem;
}

/** Everything the authenticated client and the simulator need. */
export interface OpenPaymentsConfig {
  /** Wallet address the payment is sent from; also identifies the client. */
  readonly senderWalletAddressUrl: string;
  /** Wallet address the payment is sent to. */
  readonly receiverWalletAddressUrl: string;
  /** Wallet address used as the GNAP `client` identity when signing requests. */
  readonly clientWalletAddressUrl: string;
  /** Key id (kid) of the public key published on the client wallet address. */
  readonly keyId: string;
  /** Ed25519 private key, PEM formatted. */
  readonly privateKey: string;
  /** Redirect URI the auth server sends the user back to after interaction. */
  readonly interactRedirectUri: string;
}

/** Default landing page for the interactive grant, used when unset. */
const DEFAULT_INTERACT_REDIRECT_URI = "http://localhost:3344/callback";

/**
 * Loads the credentials needed to talk to real Open Payments servers.
 * Throws with an actionable message on the first missing variable.
 */
export function loadConfig(): OpenPaymentsConfig {
  const senderWalletAddressUrl = requireOneOfEnv(
    "SENDER_WALLET_ADDRESS",
    "WALLET_ADDRESS",
  );

  return {
    senderWalletAddressUrl,
    receiverWalletAddressUrl: requireEnv("RECEIVER_WALLET_ADDRESS"),
    clientWalletAddressUrl: envOrDefault(
      "CLIENT_WALLET_ADDRESS",
      senderWalletAddressUrl,
    ),
    keyId: requireEnv("KEY_ID"),
    privateKey: getPrivateKey(),
    interactRedirectUri: envOrDefault(
      "INTERACT_REDIRECT_URI",
      DEFAULT_INTERACT_REDIRECT_URI,
    ),
  };
}

/**
 * The subset of the config needed to build an authenticated client, in the
 * exact shape `createAuthenticatedClient` expects.
 */
export function clientArgs(config: OpenPaymentsConfig): {
  walletAddressUrl: string;
  privateKey: string;
  keyId: string;
} {
  return {
    walletAddressUrl: config.clientWalletAddressUrl,
    privateKey: config.privateKey,
    keyId: config.keyId,
  };
}
