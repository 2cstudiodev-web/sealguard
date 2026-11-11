// The bot says so in Telegram when a chat is unlinked or replaced, and members can ask for a test alert.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueToken, webhookSecret } from "../worker/auth";
import { handleApi, type GuardEnv } from "../worker/guard";

const SECRET = "test-secret";
const BOT = "1:x";
const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const now = 1_800_000_000_000;
let sent: { chat: string; text: string }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const b = JSON.parse(init.body);
    sent.push({ chat: String(b.chat_id), text: b.text });
    return new Response(JSON.stringify({ ok: true }));
  });
});
afterEach(() => vi.unstubAllGlobals());

// Just enough of D1: every SELECT returns `row`, every write is recorded.
function env(row: Record<string, unknown>): GuardEnv & { writes: string[] } {
  const writes: string[] = [];
  const db: any = { prepare: (sql: string) => ({ bind: () => ({ first: async () => row, run: async () => { writes.push(sql); return {}; } }) }) };
  return { DB: db, RPC_URL: "", SESSION_SECRET: SECRET, TREASURY: "", TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_BOT_USERNAME: "seal_guard_bot", writes };
}
const post = (path: string, body: unknown = {}, headers: Record<string, string> = { authorization: `Bearer ${issueToken(SECRET, W, now - 60_000)}` }) =>
  new Request(`https://guard.2cstudio.app${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("Telegram notices", () => {
  it("tells the chat when it is unlinked", async () => {
    const e = env({ wallet: W, paid_until: now + 1e9, telegram_chat_id: "111" });
    const r = await handleApi(post("/api/guard/unlink"), e, "/api/guard/unlink", now);
    expect(r!.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat: "111" });
    expect(sent[0].text).toMatch(/^🔌 Unlinked from wallet/);
  });

  it("tells the old chat when /start links the wallet to a new one", async () => {
    const e = env({ wallet: W, link_code_expires: now + 60_000, telegram_chat_id: "111" });
    const update = { message: { text: "/start ftpFyVaKHMehqw33gDBkWZ8B", chat: { id: 222 } } };
    const r = await handleApi(post("/api/telegram", update, { "x-telegram-bot-api-secret-token": webhookSecret(BOT) }), e, "/api/telegram", now);
    expect(r!.status).toBe(200);
    expect(sent.map((m) => m.chat)).toEqual(["111", "222"]);
    expect(sent[0].text).toMatch(/now go to another Telegram chat/);
    expect(sent[1].text).toMatch(/Linked to wallet/);
  });

  it("sends a test alert to a member's chat, at most one a minute", async () => {
    const ok = await handleApi(post("/api/guard/test"), env({ wallet: W, paid_until: now + 1e9, telegram_chat_id: "111", last_test_at: null }), "/api/guard/test", now);
    expect(ok!.status).toBe(200);
    expect(sent[0].text).toMatch(/Test alert/);
    expect(sent[0].text).toMatch(/SealGuard<\/b> · wallet/);
    const soon = await handleApi(post("/api/guard/test"), env({ wallet: W, paid_until: now + 1e9, telegram_chat_id: "111", last_test_at: now - 30_000 }), "/api/guard/test", now);
    expect(soon!.status).toBe(429);
    const unpaid = await handleApi(post("/api/guard/test"), env({ wallet: W, paid_until: now - 1, telegram_chat_id: "111" }), "/api/guard/test", now);
    expect(unpaid!.status).toBe(402);
    const unlinked = await handleApi(post("/api/guard/test"), env({ wallet: W, paid_until: now + 1e9, telegram_chat_id: null }), "/api/guard/test", now);
    expect(unlinked!.status).toBe(409);
    expect(sent).toHaveLength(1);
  });
});
