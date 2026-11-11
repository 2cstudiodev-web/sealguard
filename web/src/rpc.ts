// Reading the chain through SealGuard's own /rpc relay (the Helius key stays on the server; see worker/index.ts).
import type { AssetMeta, MintInfo, NonceAcct, ScanInput, StakeAcct, TokenAcct } from "./scan";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const STAKE = "Stake11111111111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";

export class RpcError extends Error {
  constructor(message: string, public code?: number) { super(message); }
}

/** One RPC call may take this long; a stuck provider should fail the scan, not hang it. */
export const RPC_TIMEOUT_MS = 30_000;

let seq = 1;
export async function rpc<T = any>(method: string, params: unknown = []): Promise<T> {
  const r = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: seq++, method, params }), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new RpcError(j?.error?.message || j?.message || `HTTP ${r.status}`, r.status);
  if (j.error) throw new RpcError(j.error.message || "RPC error", j.error.code);
  return j.result as T;
}

function parseTokenAccounts(list: any[], program: "token" | "token2022"): TokenAcct[] {
  return list.map((x) => {
    const info = x.account.data.parsed.info;
    return {
      address: x.pubkey,
      mint: info.mint,
      program,
      amount: BigInt(info.tokenAmount?.amount ?? "0"),
      decimals: Number(info.tokenAmount?.decimals ?? 0),
      delegate: info.delegate ?? null,
      delegatedAmount: BigInt(info.delegatedAmount?.amount ?? "0"),
      closeAuthority: info.closeAuthority ?? null,
      frozen: info.state === "frozen",
      isNative: Boolean(info.isNative),
    };
  });
}

function parseMint(mint: string, acct: any): MintInfo {
  const info = acct?.data?.parsed?.info ?? {};
  const exts: any[] = Array.isArray(info.extensions) ? info.extensions : [];
  const names = exts.map((e) => String(e.extension));
  const pd = exts.find((e) => e.extension === "permanentDelegate");
  const ds = exts.find((e) => e.extension === "defaultAccountState");
  return { mint, extensions: names, permanentDelegate: pd?.state?.delegate ?? null, defaultState: ds?.state?.accountState ?? null };
}

function parseAsset(a: any): AssetMeta {
  const m = a.content?.metadata ?? {};
  return {
    mint: a.id,
    name: String(m.name ?? ""),
    symbol: String(m.symbol ?? ""),
    description: String(m.description ?? ""),
    jsonUri: String(a.content?.json_uri ?? ""),
    kind: String(a.interface ?? ""),
    priced: Boolean(a.token_info?.price_info?.price_per_token),
  };
}

export type Progress = (step: string) => void;

/** Everything scan() needs, in a handful of RPC calls. */
export async function fetchScanInput(wallet: string, onProgress: Progress = () => {}): Promise<ScanInput> {
  onProgress("Reading the wallet account");
  const acct = await rpc<any>("getAccountInfo", [wallet, { encoding: "base64" }]);
  const walletOwner: string = acct?.value?.owner ?? SYSTEM;

  onProgress("Listing token accounts");
  const [t1, t2] = await Promise.all([
    rpc<any>("getTokenAccountsByOwner", [wallet, { programId: TOKEN }, { encoding: "jsonParsed" }]),
    rpc<any>("getTokenAccountsByOwner", [wallet, { programId: TOKEN_2022 }, { encoding: "jsonParsed" }]),
  ]);
  const tokenAccounts = [...parseTokenAccounts(t1?.value ?? [], "token"), ...parseTokenAccounts(t2?.value ?? [], "token2022")];

  // Token-2022 mints carry the extensions worth looking at; classic mints have none.
  const mints: Record<string, MintInfo> = {};
  const mints22 = [...new Set(tokenAccounts.filter((t) => t.program === "token2022").map((t) => t.mint))];
  if (mints22.length) {
    onProgress("Reading Token-2022 mints");
    for (let i = 0; i < mints22.length; i += 100) {
      const chunk = mints22.slice(i, i + 100);
      const r = await rpc<any>("getMultipleAccounts", [chunk, { encoding: "jsonParsed" }]);
      (r?.value ?? []).forEach((a: any, k: number) => { mints[chunk[k]] = parseMint(chunk[k], a); });
    }
  }

  onProgress("Reading token names (DAS)");
  const assets: Record<string, AssetMeta> = {};
  let dasFailed = false;
  try {
    for (let page = 1; page <= 5; page++) {
      const r = await rpc<any>("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000, displayOptions: { showFungible: true, showZeroBalance: false } });
      const items: any[] = r?.items ?? [];
      for (const a of items) assets[a.id] = parseAsset(a);
      if (items.length < 1000) break;
    }
  } catch {
    // DAS is a Helius extra; without it the phishing rule just has fewer names to look at.
    dasFailed = true;
  }

  const warnings: string[] = [];
  if (dasFailed) warnings.push("Token names couldn't be read, so the phishing check only saw what the token accounts themselves say.");
  onProgress("Checking stake accounts");
  const stakes: StakeAcct[] = [];
  const seen = new Set<string>();
  try {
    for (const offset of [12, 44]) {
      const r = await rpc<any>("getProgramAccounts", [STAKE, { encoding: "jsonParsed", filters: [{ memcmp: { offset, bytes: wallet } }] }]);
      for (const x of r ?? []) {
        if (seen.has(x.pubkey)) continue;
        seen.add(x.pubkey);
        const auth = x.account?.data?.parsed?.info?.meta?.authorized ?? {};
        stakes.push({ address: x.pubkey, staker: String(auth.staker ?? ""), withdrawer: String(auth.withdrawer ?? ""), lamports: Number(x.account?.lamports ?? 0) });
      }
    }
  } catch (e: any) {
    warnings.push(`Stake accounts couldn't be checked (${e?.message || e}).`);
  }

  onProgress("Checking nonce accounts");
  const nonces: NonceAcct[] = [];
  try {
    const nr = await rpc<any>("getProgramAccounts", [SYSTEM, { encoding: "jsonParsed", filters: [{ dataSize: 80 }, { memcmp: { offset: 8, bytes: wallet } }] }]);
    for (const x of nr ?? []) {
      const info = x.account?.data?.parsed?.info ?? {};
      if (x.account?.data?.parsed?.type !== "nonce") continue;
      nonces.push({ address: x.pubkey, authority: String(info.authority ?? ""), lamports: Number(x.account?.lamports ?? 0) });
    }
  } catch (e: any) {
    warnings.push(`Nonce accounts couldn't be checked (${e?.message || e}).`);
  }

  return { wallet, walletOwner, tokenAccounts, mints, assets, stakes, nonces, warnings };
}
