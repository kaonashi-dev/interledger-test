import { createAuthenticatedClient } from "@interledger/open-payments";
import { clientArgs, loadConfig } from "./config.ts";

const config = loadConfig();

const client = await createAuthenticatedClient(clientArgs(config));

const walletAddress = await client.walletAddress.get({
    url: config.senderWalletAddressUrl,
});
const walletAddressKeys = await client.walletAddress.getKeys({
    url: config.senderWalletAddressUrl,
});

console.log("WALLET ADDRESS:", walletAddress);
console.log("WALLET ADDRESS KEYS:", walletAddressKeys);
