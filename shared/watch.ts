// What the guard watches between checks. A WatchState is the small, stable part of a scan that a thief or a
// phishing site changes; diffing two of them gives the alerts. Pure, so it's unit-tested without a chain.
import { looksLikePhishing, shortKey, SYSTEM_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS, type ScanInput } from "../web/src/scan";

export type WatchState = {
  v: 1;
  owner: string;
  /** token account → delegate, for accounts that hold something and have a live delegate. */
  delegates: Record<string, string>;
  /** stake account → withdrawer, where the wallet is the staker. */
  stakeWithdrawers: Record<string, string>;
  nonces: string[];
  /** mints of tokens that look like phishing airdrops (held, unpriced). */
  phishing: Record<string, string>;
  /** token accounts frozen by their issuer (a sudden freeze of a real holding is worth a line). */
  frozen: string[];
  /** Not compared: empty accounts and the rent closing them would return, for the monthly reminder. */
  emptyAccounts?: number;
  reclaimLamports?: number;
};

export function watchState(input: ScanInput): WatchState {
  const delegates: Record<string, string> = {};
  const phishing: Record<string, string> = {};
  const frozen: string[] = [];
  let emptyAccounts = 0, reclaimLamports = 0;
  for (const t of input.tokenAccounts) {
    if (t.amount === 0n && !t.frozen) { emptyAccounts++; reclaimLamports += t.lamports ?? TOKEN_ACCOUNT_RENT_LAMPORTS; }
    if (t.delegate && t.amount > 0n && t.delegatedAmount > 0n) delegates[t.address] = t.delegate;
    const a = input.assets[t.mint];
    if (a && t.amount > 0n && looksLikePhishing(a)) phishing[t.mint] = a.name || a.symbol || shortKey(t.mint);
    if (t.frozen && t.amount > 0n) frozen.push(t.address);
  }
  const stakeWithdrawers: Record<string, string> = {};
  for (const s of input.stakes) if (s.staker === input.wallet) stakeWithdrawers[s.address] = s.withdrawer;
  return {
    v: 1,
    owner: input.walletOwner || SYSTEM_PROGRAM,
    delegates,
    stakeWithdrawers,
    nonces: input.nonces.map((n) => n.address).sort(),
    phishing,
    frozen: frozen.sort(),
    emptyAccounts,
    reclaimLamports,
  };
}

/** fix: an account the page can select a fix for (guard.2cstudio.app/?fix=<account>). */
export type Alert = { severity: "critical" | "high" | "medium"; text: string; fix?: string };

/** What changed for the worse since `prev`. Things getting better (a revoked approval) are not alerts. */
export function diffWatch(prev: WatchState, next: WatchState, wallet: string): Alert[] {
  const out: Alert[] = [];
  if (next.owner !== prev.owner && next.owner !== SYSTEM_PROGRAM) {
    out.push({ severity: "critical", text: `The wallet account's owner was changed to program ${shortKey(next.owner)}. This is what drainers do once they have a signature. Move whatever you still can to a brand-new wallet now.` });
  }
  for (const [acct, delegate] of Object.entries(next.delegates)) {
    if (prev.delegates[acct] !== delegate) out.push({ severity: "high", text: `New approval: ${shortKey(delegate)} can now spend from token account ${shortKey(acct)}. If you didn't do this on purpose, revoke it.`, fix: acct });
  }
  for (const [acct, withdrawer] of Object.entries(next.stakeWithdrawers)) {
    if (withdrawer !== wallet && prev.stakeWithdrawers[acct] !== withdrawer) out.push({ severity: "high", text: `Stake account ${shortKey(acct)} now has ${shortKey(withdrawer)} as its withdraw authority.` });
  }
  for (const n of next.nonces) {
    if (!prev.nonces.includes(n)) out.push({ severity: "medium", text: `A durable nonce account ${shortKey(n)} now belongs to your wallet. If you didn't create it, withdraw it.`, fix: n });
  }
  for (const [mint, name] of Object.entries(next.phishing)) {
    if (!prev.phishing[mint]) out.push({ severity: "medium", text: `A token that looks like a phishing airdrop arrived: "${name}". Don't open its link; you can burn it.`, fix: mint });
  }
  for (const acct of next.frozen) {
    if (!prev.frozen.includes(acct)) out.push({ severity: "medium", text: `Token account ${shortKey(acct)} was frozen by its issuer.` });
  }
  return out;
}

const ICON = { critical: "🚨", high: "⚠️", medium: "ℹ️" } as const;

/** The Telegram message for a batch of alerts (HTML parse mode; caller escapes nothing here because texts hold only addresses and names we quote). */
export function formatAlerts(wallet: string, alerts: Alert[], esc: (s: string) => string): string {
  const head = `<b>SealGuard</b> · wallet <code>${esc(shortKey(wallet))}</code>`;
  return [head, ...alerts.map((a) => `${ICON[a.severity]} ${esc(a.text)}${a.fix ? ` <a href="https://guard.2cstudio.app/?fix=${encodeURIComponent(a.fix)}">Fix it</a>` : ""}`), `<a href="https://guard.2cstudio.app/">Open SealGuard</a>`].join("\n");
}

export function weeklyText(wallet: string, checks: number, alerts: number, paidUntil: number, esc: (s: string) => string): string {
  const until = new Date(paidUntil).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const what = alerts ? `${alerts} alert${alerts === 1 ? "" : "s"} sent` : "nothing changed for the worse";
  return `🛡 Weekly check for wallet <code>${esc(shortKey(wallet))}</code>: ${checks} check${checks === 1 ? "" : "s"} this week, ${what}. Guard active until ${until}.`;
}

export function claimText(wallet: string, accounts: number, lamportsText: string, esc: (s: string) => string): string {
  return `🧹 Wallet <code>${esc(shortKey(wallet))}</code> has ${accounts} empty token account${accounts === 1 ? "" : "s"} holding ${esc(lamportsText)}. With your guard, closing them is free: https://guard.2cstudio.app/?claim=1`;
}
