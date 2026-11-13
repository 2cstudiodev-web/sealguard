// The API key card (/mcp-key → /?apikey=1#apikey): for AI agents that call check_transaction over MCP. Sign in with
// the wallet that owns the key, buy checks, make or replace the key. Sign-in and payments are the guard card's
// (guard.ts); the key itself is shown once and never stored in this browser.
import { freshApi, guardApi, showPayChoices, signedIn, signInFor, type Say } from "./guard";
import type { Connected } from "./wallet";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const MCP_URL = "https://guard.2cstudio.app/mcp";

type Account = { credits: number; member: boolean; memberMonthly: number; memberUsed: number; usedTotal: number; key: { prefix: string; createdAt: number; lastUsedAt: number | null } | null; packChecks: number; packUsd: string; checkUsd: number };

let connected: Connected | null = null;
let acct: Account | null = null;
/** The key just made, shown until the page is left. */
let fresh: string | null = null;
/** Free checks that came with the key just made (the wallet's first). */
let freshTrial = 0;

/** The card is for people who came for it (/mcp-key), not on every visit. */
export const apiKeyPage = () => /[?&]apikey=1\b/.test(location.search) || location.hash === "#apikey";

const say: Say = (text, kind = "") => {
  const el = $("#akstatus");
  el.textContent = text;
  el.className = `status ${kind}`;
};

export async function setApiKeyWallet(c: Connected | null): Promise<void> {
  if (!apiKeyPage()) return;
  const card = $("#apikey");
  card.hidden = false;
  if (c?.address !== connected?.address) fresh = null;
  connected = c;
  acct = null;
  if (c && signedIn()) {
    try { acct = await guardApi<Account>("/api/mcp/account"); } catch { /* sign in again */ }
  }
  render();
}

function render(): void {
  const box = $("#akbody");
  if (!connected) {
    box.innerHTML = `<p>Connect the wallet that will own the key. Its checks and its guard allowance are tied to it.</p><button id="akconnect" class="btn primary">Connect wallet</button>`;
    $("#akconnect").addEventListener("click", () => ($("#heroconnect") as HTMLButtonElement).click());
    return;
  }
  if (!acct) {
    box.innerHTML = `<p>Sign in with this wallet to see its checks and its key. Signing in is a signature on a short message, not a transaction: it moves nothing and costs nothing.</p><button id="aksignin" class="btn primary">Sign in</button>`;
    $("#aksignin").addEventListener("click", async () => { if (await signInFor(say)) await setApiKeyWallet(connected); });
    return;
  }
  const a = acct;
  const lines: string[] = [];
  const left = a.credits + (a.member ? Math.max(0, a.memberMonthly - a.memberUsed) : 0);
  lines.push(`<p class="okline"><b>${left.toLocaleString("en-US")}</b> check${left === 1 ? "" : "s"} available: ${a.credits.toLocaleString("en-US")} prepaid${a.member ? ` + ${Math.max(0, a.memberMonthly - a.memberUsed).toLocaleString("en-US")} of this month's ${a.memberMonthly.toLocaleString("en-US")} with the guard` : ""}. ${a.usedTotal ? `${a.usedTotal.toLocaleString("en-US")} used so far.` : ""}</p>`);
  lines.push(`<p><button id="akbuy" class="btn small${a.credits || a.member ? "" : " primary"}">Buy ${a.packChecks} checks for US$${Number(a.packUsd).toFixed(0)}</button> <span class="small muted">US$${a.checkUsd.toFixed(2)} a check; paid in USDC, SOL or SKR from this wallet. Checks don't expire.${a.member ? "" : " Wallets with the guard get " + a.memberMonthly.toLocaleString("en-US") + " a month included."}</span></p><div id="akquotes"></div>`);
  if (fresh) {
    lines.push(`<p><b>Your new key.</b> Copy it now: SealGuard keeps only a fingerprint and can't show it again.${freshTrial ? ` It comes with ${freshTrial} free checks.` : ""}</p>
<p class="cmdline"><code id="akkey">${esc(fresh)}</code> <button id="akcopy" class="btn small" type="button">Copy</button></p>
<p class="small">Add it to your MCP client as a header on ${esc(MCP_URL)}:</p>
<pre class="akcfg"><code>${esc(JSON.stringify({ mcpServers: { sealguard: { url: MCP_URL, headers: { Authorization: `Bearer ${fresh}` } } } }, null, 2))}</code></pre>`);
  } else if (a.key) {
    lines.push(`<p>Active key: <code>${esc(a.key.prefix)}…</code>, made ${new Date(a.key.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}${a.key.lastUsedAt ? `, last used ${new Date(a.key.lastUsedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}. <button id="akrotate" class="linkbtn" type="button">Replace it</button> · <button id="akrevoke" class="linkbtn" type="button">Turn it off</button></p>`);
  } else {
    lines.push(`<p><button id="akrotate" class="btn primary small" type="button">Make a key</button> <span class="small muted">One key per wallet; making a new one turns the old one off. A wallet's first key comes with 20 free checks.</span></p>`);
  }
  lines.push(`<p class="small muted">Only check_transaction uses checks. scan_wallet, list_empty_token_accounts and list_token_approvals stay free and need no key. A check is taken only when SealGuard returns an answer. Setup and examples: <a href="/docs/mcp">MCP for AI apps</a>.</p>`);
  box.innerHTML = lines.join("");
  $("#akbuy").addEventListener("click", () => showPayChoices({
    quotePath: "/api/mcp/quote", payPath: "/api/mcp/pay", box: "#akquotes", say,
    paidText: `Paid. ${a.packChecks} checks added.`,
    paid: async () => { acct = await guardApi<Account>("/api/mcp/account"); render(); },
  }));
  $("#akrotate")?.addEventListener("click", rotate);
  $("#akrevoke")?.addEventListener("click", revoke);
  $("#akcopy")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(fresh!); $("#akcopy").textContent = "Copied"; } catch {
      const range = document.createRange(); range.selectNodeContents($("#akkey"));
      const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    }
  });
}

const KEY_SIG = "Changing the key needs one more signature. Waiting for it…";

async function rotate(): Promise<void> {
  if (acct?.key && !confirm("Make a new key? The current one stops working right away.")) return;
  try {
    say("Making the key…", "busy");
    const r = await freshApi<{ key: string; trialChecks?: number }>("/api/mcp/key", say, KEY_SIG);
    fresh = r.key;
    freshTrial = r.trialChecks ?? 0;
    acct = await guardApi<Account>("/api/mcp/account");
    say("");
    render();
  } catch (e: any) { say(e?.message || "Couldn't make the key", "err"); }
}

async function revoke(): Promise<void> {
  if (!confirm("Turn the key off? Anything using it stops working. Your checks stay on this wallet.")) return;
  try {
    await freshApi("/api/mcp/key/revoke", say, KEY_SIG);
    fresh = null;
    acct = await guardApi<Account>("/api/mcp/account");
    say("Key turned off.", "ok");
    render();
  } catch (e: any) { say(e?.message || "Failed", "err"); }
}
