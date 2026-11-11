# SealGuard

A free check-up for Solana wallets: https://guard.2cstudio.app

Connect a wallet (read-only) and SealGuard tells you who can move your tokens and what looks wrong:

- standing approvals (delegates) on your token accounts, with one-tap revoke
- Token-2022 mints with a permanent delegate, transfer hook, non-transferable or frozen-by-default flag
- accounts frozen by the issuer, or closable by someone else
- empty token accounts you can close to get the rent deposit back
- phishing airdrops (tokens whose name is a web address or a "claim your reward" line), with burn + close
- stake accounts whose withdraw authority isn't you
- durable nonce accounts tied to your wallet
- whether the wallet account's owner has been reassigned (the sign of a drained wallet)

Every fix is an ordinary Token Program or System Program instruction built in your browser, simulated, then signed by your own wallet. The server only relays read calls to an RPC provider so its API key stays off the page. SealGuard never asks for a seed phrase, never holds a key and never signs anything.

## What it can't do

Most Solana thefts are one signature on a transfer on a phishing site, not a standing approval. SealGuard can't stop that. It reads the chain, not your computer.

## Layout

- `web/` the page (Vite + TypeScript, no framework). `src/scan.ts` holds the rules as pure functions; `src/tx.ts` builds the transactions; `src/rpc.ts` reads the chain; `src/wallet.ts` connects through the Wallet Standard (Phantom, Solflare, Backpack, and Mobile Wallet Adapter on Android).
- `worker/` the Cloudflare Worker that serves `dist/` and relays `/rpc`.
- `test/` vitest for the rules and the transaction builder.

## Run it

```
npm install
npx wrangler secret put RPC_URL    # a Helius (DAS-capable) RPC URL; for local dev put it in .dev.vars
npm run build && npx wrangler dev   # http://127.0.0.1:8787
```

For live-reload while editing the page: `npx wrangler dev` in one terminal and `npm run dev` in another (Vite proxies `/rpc` to the Worker).

## Licence

MIT. See `LICENSE`.
