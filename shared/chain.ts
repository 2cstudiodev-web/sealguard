// Reading everything scan() needs from the chain. Shared by the page (through the /rpc relay) and the Worker's
// guard cron (straight to the RPC provider): the caller passes the function that makes one JSON-RPC call.
import type { AssetMeta, MintInfo, NonceAcct, ScanInput, StakeAcct, TokenAcct } from "../web/src/scan";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type RpcCall = <T = any>(method: string, params?: unknown) => Promise<T>;

export class RpcError extends Error {
  constructor(message: string, public code?: number) { super(message); }
}

/** JSON-RPC over fetch to one URL (the Worker uses this with the provider URL; the page with "/rpc"). */
export function rpcOver(url: string, timeoutMs = 30_000, fetchFn: typeof fetch = (i, o) => fetch(i, o)): RpcCall {
  let seq = 1;
  return async <T = any>(method: string, params: unknown = []): Promise<T> => {
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: seq++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new RpcError(j?.error?.message || j?.message || `HTTP ${r.status}`, r.status);
    if (j.error) throw new RpcError(j.error.message || "RPC error", j.error.code);
    return j.result as T;
  };
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
    priceUsd: typeof a.token_info?.price_info?.price_per_token === "number" ? a.token_info.price_info.price_per_token : null,
  };
}

export type Progress = (step: string) => void;

/**
 * Accounts of a program matching the filters. Helius refuses plain getProgramAccounts on the big programs (the
 * System Program holds every nonce account) and wants its paginated getProgramAccountsV2; other providers only
 * have the classic call. Try V2 first and fall back when the method is unknown.
 */
async function programAccounts(rpc: RpcCall, program: string, filters: unknown[]): Promise<any[]> {
  try {
    const out: any[] = [];
    let paginationKey: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r: any = await rpc("getProgramAccountsV2", [program, { encoding: "jsonParsed", filters, limit: 1000, ...(paginationKey ? { paginationKey } : {}) }]);
      out.push(...(r?.accounts ?? []));
      paginationKey = r?.paginationKey ?? null;
      if (!paginationKey) break;
    }
    return out;
  } catch (e: any) {
    if (e instanceof RpcError && (e.code === -32601 || /not found|not allowed|unknown method|not supported/i.test(e.message))) {
      return (await rpc<any>("getProgramAccounts", [program, { encoding: "jsonParsed", filters }])) ?? [];
    }
    throw e;
  }
}

/** Everything scan() needs, in a handful of RPC calls. */
export async function fetchScanInput(rpc: RpcCall, wallet: string, onProgress: Progress = () => {}): Promise<ScanInput> {
  onProgress("Reading the wallet account");
  const acct = await rpc<any>("getAccountInfo", [wallet, { encoding: "base64" }]);
  const walletOwner: string = acct?.value?.owner ?? SYSTEM_PROGRAM_ID;

  onProgress("Listing token accounts");
  const [t1, t2] = await Promise.all([
    rpc<any>("getTokenAccountsByOwner", [wallet, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }]),
    rpc<any>("getTokenAccountsByOwner", [wallet, { programId: TOKEN_2022_PROGRAM }, { encoding: "jsonParsed" }]),
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

  // The SOL price, for the "≈ US$" next to rent and stake amounts (the DAS feed prices wrapped SOL).
  let solPriceUsd: number | null = null;
  try {
    const sol = await rpc<any>("getAsset", { id: WSOL_MINT });
    const p = sol?.token_info?.price_info?.price_per_token;
    if (typeof p === "number" && p > 0) solPriceUsd = p;
  } catch {
    // No price feed: amounts show in SOL only.
  }

  const warnings: string[] = [];
  if (dasFailed) warnings.push("Token names couldn't be read, so the phishing check only saw what the token accounts themselves say.");
  onProgress("Checking stake accounts");
  const stakes: StakeAcct[] = [];
  const seen = new Set<string>();
  try {
    for (const offset of [12, 44]) {
      const r = await programAccounts(rpc, STAKE_PROGRAM, [{ memcmp: { offset, bytes: wallet } }]);
      for (const x of r) {
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
    const nr = await programAccounts(rpc, SYSTEM_PROGRAM_ID, [{ dataSize: 80 }, { memcmp: { offset: 8, bytes: wallet } }]);
    for (const x of nr) {
      const info = x.account?.data?.parsed?.info ?? {};
      if (x.account?.data?.parsed?.type !== "nonce") continue;
      nonces.push({ address: x.pubkey, authority: String(info.authority ?? ""), lamports: Number(x.account?.lamports ?? 0) });
    }
  } catch (e: any) {
    warnings.push(`Nonce accounts couldn't be checked (${e?.message || e}).`);
  }

  return { wallet, walletOwner, tokenAccounts, mints, assets, stakes, nonces, warnings, solPriceUsd };
}
