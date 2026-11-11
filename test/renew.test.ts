import { describe, expect, it } from "vitest";
import { endedText, reminderText, REMIND_BEFORE_MS, sendRenewalNotices, type GuardEnv } from "../worker/guard";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const DAY = 86_400_000;

/** A guards table for the two renewal queries and their updates. */
function db(rows: any[]) {
  return {
    prepare: (sql: string) => {
      let a: any[] = [];
      const st = {
        bind: (...x: any[]) => { a = x; return st; },
        all: async () => {
          if (sql.includes("reminded_until IS NULL")) {
            const [now, until] = a;
            return { results: rows.filter((r) => r.telegram_chat_id && r.paid_until > now && r.paid_until <= until && r.reminded_until !== r.paid_until) };
          }
          const [now, since] = a;
          return { results: rows.filter((r) => r.telegram_chat_id && r.paid_until <= now && r.paid_until > since && r.ended_notice_until !== r.paid_until) };
        },
        run: async () => {
          const [v, w] = a;
          const r = rows.find((x) => x.wallet === w)!;
          if (sql.includes("SET reminded_until")) r.reminded_until = v; else r.ended_notice_until = v;
          return {};
        },
      };
      return st;
    },
  } as unknown as D1Database;
}

describe("renewal notices", () => {
  it("reminds once a week before the end, and tells once when it has ended", async () => {
    const now = Date.UTC(2026, 10, 11);
    const rows = [
      { wallet: W, telegram_chat_id: "1", paid_until: now + 5 * DAY, reminded_until: null, ended_notice_until: null },
      { wallet: "B".repeat(44), telegram_chat_id: "2", paid_until: now - DAY, reminded_until: null, ended_notice_until: null },
      { wallet: "C".repeat(44), telegram_chat_id: "3", paid_until: now + 30 * DAY, reminded_until: null, ended_notice_until: null },
      { wallet: "D".repeat(44), telegram_chat_id: "4", paid_until: now - 10 * DAY, reminded_until: null, ended_notice_until: null },
    ];
    const sent: any[] = [];
    const fetchFn = (async (_u: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response("{}"); }) as typeof fetch;
    const env = { DB: db(rows), RPC_URL: "", SESSION_SECRET: "s", TREASURY: "t", TELEGRAM_BOT_TOKEN: "1:x" } as GuardEnv;

    expect(await sendRenewalNotices(env, now, fetchFn)).toEqual({ reminded: 1, ended: 1 });
    expect(sent.map((m) => m.chat_id)).toEqual(["1", "2"]);
    expect(sent[0].text).toContain("ends on 16 Nov 2026");
    expect(sent[0].text).toContain("US$49");
    expect(sent[1].text).toContain("ended today");

    // Run again: nothing new to say.
    expect(await sendRenewalNotices(env, now + 600_000, fetchFn)).toEqual({ reminded: 0, ended: 0 });
    // After renewing (paid_until moves), the next period gets its own reminder in time.
    rows[0].paid_until = now + 365 * DAY;
    expect(await sendRenewalNotices(env, now + 365 * DAY - REMIND_BEFORE_MS + 1, fetchFn)).toEqual({ reminded: 1, ended: 0 });
  });

  it("writes plain messages", () => {
    expect(reminderText(W, Date.UTC(2027, 0, 5))).toBe("⏰ Your SealGuard guard for wallet <code>JCDr…stB2</code> ends on 5 Jan 2027. To keep the alerts coming, renew for another year (US$49) at https://guard.2cstudio.app/: sign in with the same wallet and press Extend by a year.");
    expect(endedText(W)).toBe("Your SealGuard guard for wallet <code>JCDr…stB2</code> ended today, so alerts have stopped. You can renew any time at https://guard.2cstudio.app/.");
  });
});
