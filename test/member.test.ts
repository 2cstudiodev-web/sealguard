import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { scan, SYSTEM_PROGRAM, type ScanInput, type TokenAcct } from "../web/src/scan";
import { buildTransaction, groupFee } from "../web/src/tx";
import { claimText, diffWatch, formatAlerts, watchState, weeklyText } from "../shared/watch";
import { sendDigests, CLAIM_MIN_LAMPORTS, type GuardEnv } from "../worker/guard";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: "acct", mint: "mint", program: "token", amount: 0n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, lamports: 2_039_280, ...p });
const input = (p: Partial<ScanInput>): ScanInput => ({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [], ...p });
const esc = (s: string) => s.replace(/</g, "&lt;");

describe("members", () => {
  it("close empty accounts with no fee", () => {
    const [a, b] = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
    const r = scan(input({ tokenAccounts: [acct({ address: a, mint: OTHER }), acct({ address: b, mint: OTHER })] }), { closeFeeBps: 0 });
    expect(r.reclaim).toMatchObject({ lamports: 4_078_560, fee: 0, net: 4_078_560 });
    expect(r.findings[0].detail).toContain("No fee: this wallet has the guard.");
    const closes = r.findings.map((f) => f.action!);
    expect(groupFee(closes, 0)).toBe(0);
    const tx = buildTransaction(closes, Keypair.generate().publicKey, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", 1, { feeBps: 0 });
    expect(tx.instructions).toHaveLength(2);
  });

  it("alerts carry a fix-it link for approvals, nonces and phishing tokens", () => {
    const before = watchState(input({}));
    const after = watchState(input({
      tokenAccounts: [acct({ address: "acct1", amount: 5n, delegate: OTHER, delegatedAmount: 5n })],
      nonces: [{ address: "nonce1", authority: W, lamports: 1 }],
    }));
    const alerts = diffWatch(before, after, W);
    expect(alerts.map((a) => a.fix)).toEqual(["acct1", "nonce1"]);
    const msg = formatAlerts(W, alerts, esc);
    expect(msg).toContain('<a href="https://guard.2cstudio.app/?fix=acct1">Fix it</a>');
  });

  it("counts rent to claim in the watch state without alerting on it", () => {
    const s = watchState(input({ tokenAccounts: [acct({ address: "a" }), acct({ address: "b", lamports: 1_000_000 })] }));
    expect(s).toMatchObject({ emptyAccounts: 2, reclaimLamports: 3_039_280 });
    expect(diffWatch(watchState(input({})), s, W)).toEqual([]);
  });

  it("writes the weekly and monthly messages", () => {
    expect(weeklyText(W, 168, 0, Date.UTC(2027, 10, 11), esc)).toBe("🛡 Weekly check for wallet <code>JCDr…stB2</code>: 168 checks this week, nothing changed for the worse. Guard active until 11 Nov 2027.");
    expect(weeklyText(W, 168, 2, Date.UTC(2027, 10, 11), esc)).toContain("2 alerts sent");
    expect(claimText(W, 16, "0.0325 SOL (≈ US$2.70)", esc)).toBe("🧹 Wallet <code>JCDr…stB2</code> has 16 empty token accounts holding 0.0325 SOL (≈ US$2.70). With your guard, closing them is free: https://guard.2cstudio.app/?claim=1");
  });

  it("sends the weekly all-clear after a week and the claim reminder after a month, above the threshold only", async () => {
    const DAY = 86_400_000, start = Date.UTC(2026, 10, 1);
    const sent: any[] = [], updates: string[] = [];
    const env = {
      DB: { prepare: (sql: string) => ({ bind: () => ({ run: async () => { updates.push(sql.split(" SET ")[1].split(" ")[0]); return {}; } }) }) },
      TELEGRAM_BOT_TOKEN: "1:x", RPC_URL: "", SESSION_SECRET: "s", TREASURY: "t",
    } as unknown as GuardEnv;
    const fetchFn = (async (_u: any, init: any) => { sent.push(JSON.parse(init.body).text); return new Response("{}"); }) as typeof fetch;
    const g: any = { wallet: W, created_at: start, activated_at: start, paid_until: start + 365 * DAY, telegram_chat_id: "1", checks: 167, alerts: 0, weekly_checks_base: 0, weekly_alerts_base: 0, last_weekly_at: null, last_claim_notice_at: null };
    const next: any = { emptyAccounts: 16, reclaimLamports: 32_488_280 };

    await sendDigests(env, g, next, 83, 0, start + 3 * DAY, fetchFn);
    expect(sent).toEqual([]);
    await sendDigests(env, g, next, 83, 0, start + 8 * DAY, fetchFn);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("168 checks this week");
    expect(updates).toEqual(["last_weekly_at"]);
    // A month in: this week's all-clear and the rent reminder.
    await sendDigests(env, { ...g, last_weekly_at: start + 29 * DAY }, next, 83, 0, start + 31 * DAY, fetchFn);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("16 empty token accounts");
    // Below 0.01 SOL of rent: no reminder.
    await sendDigests(env, { ...g, last_weekly_at: start + 31 * DAY, last_claim_notice_at: null }, { emptyAccounts: 1, reclaimLamports: CLAIM_MIN_LAMPORTS - 1 } as any, 83, 0, start + 32 * DAY, fetchFn);
    expect(sent).toHaveLength(2);
  });
});
