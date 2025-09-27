import { createAuthenticatedClient } from "@interledger/open-payments";

const client = await createAuthenticatedClient({
    walletAddressUrl: Bun.env.WALLET_ADDRESS,
    privateKey: Buffer.from(Bun.env.PRIVATE_KEY, "base64").toString("utf-8"),
    keyId: Bun.env.KEY_ID,
});

const walletAddress = await client.walletAddress.get({
    url: Bun.env.WALLET_ADDRESS,
});
const walletAddressKeys = await client.walletAddress.getKeys({
    url: Bun.env.WALLET_ADDRESS,
});

console.log("WALLET ADDRESS:", walletAddress);
console.log("WALLET ADDRESS KEYS:", walletAddressKeys);

