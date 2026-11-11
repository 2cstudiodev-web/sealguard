// The guard cron against a tiny in-memory D1 and a fake RPC/Telegram: a new approval shows up, the owner is
// messaged once, the baseline moves on.
import { describe, expect, it } from "vitest";
import { runGuards, type GuardEnv } from "../worker/guard";
import { watchState } from "../shared/watch";
import { SYSTEM_PROGRAM } from "../web/src/scan";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** Just enough of D1 for runGuards: one guards table as an array of rows, a meta map. */
function fakeDb(rows: any[]) {
  const meta = new Map<string, string>();
  const stmt = (sql: string) => {
    let args: any[] = [];
    const s = {
      bind: (...a: any[]) => { args = a; return s; },
      first: async () => {
        if (sql.includes("FROM meta")) return meta.has("webhook") ? { v: meta.get("webhook") } : null;
        return null;
      },
      all: async () => {
        if (sql.includes("FROM guards")) {
          const [now, cutoff, limit] = args;
          return { results: rows.filter((r) => r.paid_until > now && r.telegram_chat_id && (r.last_check_at == null || r.last_check_at < cutoff)).slice(0, limit) };
        }
        return { results: [] };
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO meta")) meta.set("webhook", args[0]);
        else if (sql.includes("UPDATE guards SET baseline")) {
          const [baseline, lastCheck, alertsAdd, sent, alertAt, wallet] = args;
          const r = rows.find((x) => x.wallet === wallet)!;
          Object.assign(r, { baseline, last_check_at: lastCheck, checks: r.checks + 1, alerts: r.alerts + alertsAdd, last_alert_at: sent ? alertAt : r.last_alert_at, last_error: null });
        } else if (sql.includes("UPDATE guards SET last_check_at")) {
          const [lastCheck, err, wallet] = args;
          Object.assign(rows.find((x) => x.wallet === wallet)!, { last_check_at: lastCheck, last_error: err });
        }
        return {};
      },
    };
    return s;
  };
  return { prepare: stmt, batch: async (xs: any[]) => Promise.all(xs.map((x) => x.run())) } as unknown as D1Database;
}

/** RPC answers for a wallet with one token account, with or without a delegate; everything else empty. */
function rpcAnswers(delegate: string | null) {
  return (method: string): any => {
    switch (method) {
      case "getAccountInfo": return { value: { owner: SYSTEM_PROGRAM } };
      case "getTokenAccountsByOwner": return { value: [{ pubkey: "acct1", account: { data: { parsed: { info: { mint: "mint1", tokenAmount: { amount: "100", decimals: 0 }, delegate, delegatedAmount: delegate ? { amount: "100" } : undefined, state: "initialized" } } } } }] };
      case "getMultipleAccounts": return { value: [] };
      case "getAssetsByOwner": return { items: [] };
      case "getAsset": return { token_info: { price_info: { price_per_token: 80 } } };
      case "getProgramAccountsV2": return { accounts: [], paginationKey: null };
      default: return null;
    }
  };
}

function fakeFetch(answers: (m: string) => any, telegram: any[]): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) { telegram.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answers(body.method) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("guard cron", () => {
  it("messages the owner once when a new approval appears, then moves the baseline", async () => {
    const now = 1_762_800_000_000;
    const baseline = JSON.stringify(watchState({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [] }));
    const rows = [{ wallet: W, created_at: now - 1, paid_until: now + 1e9, telegram_chat_id: "42", link_code: null, link_code_expires: null, baseline, last_check_at: null, last_alert_at: null, checks: 0, alerts: 0, last_error: null }];
    const telegram: any[] = [];
    const env: GuardEnv = { DB: fakeDb(rows), RPC_URL: "https://rpc.test/", SESSION_SECRET: "s", TREASURY: "t", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_BOT_USERNAME: "bot", PUBLIC_URL: "https://guard.test" };

    const r1 = await runGuards(env, now, fakeFetch(rpcAnswers(OTHER), telegram));
    expect(r1).toEqual({ checked: 1, alerted: 1 });
    // One setWebhook call, then the alert.
    expect(telegram.some((t) => t.url === "https://guard.test/api/telegram")).toBe(true);
    const alert = telegram.find((t) => t.chat_id === "42");
    expect(alert.text).toContain("New approval");
    expect(alert.text).toContain("9xQe…VFin");
    expect(rows[0].alerts).toBe(1);
    expect(JSON.parse(rows[0].baseline).delegates).toEqual({ acct1: OTHER });

    // Same state an hour later: nothing new, no message.
    telegram.length = 0;
    const r2 = await runGuards(env, now + 3_600_000, fakeFetch(rpcAnswers(OTHER), telegram));
    expect(r2).toEqual({ checked: 1, alerted: 0 });
    expect(telegram.filter((t) => t.chat_id === "42")).toHaveLength(0);

    // Not due yet (checked 10 minutes ago): skipped.
    const r3 = await runGuards(env, now + 3_600_000 + 600_000, fakeFetch(rpcAnswers(OTHER), telegram));
    expect(r3).toEqual({ checked: 0, alerted: 0 });
  });

  it("records an error and keeps the baseline when the chain can't be read", async () => {
    const now = 1_762_800_000_000;
    const rows = [{ wallet: W, created_at: 0, paid_until: now + 1e9, telegram_chat_id: "42", link_code: null, link_code_expires: null, baseline: "{}", last_check_at: null, last_alert_at: null, checks: 0, alerts: 0, last_error: null }];
    const env: GuardEnv = { DB: fakeDb(rows), RPC_URL: "https://rpc.test/", SESSION_SECRET: "s", TREASURY: "t" };
    const failing = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    expect(await runGuards(env, now, failing)).toEqual({ checked: 0, alerted: 0 });
    expect(rows[0].last_error).toMatch(/HTTP 500/);
    expect(rows[0].baseline).toBe("{}");
  });
});
