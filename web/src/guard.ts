// The guard card: sign in with the wallet, link Telegram, pay for a year, see the status.
import { PublicKey } from "@solana/web3.js";
import { rpc } from "./rpc";
import { paymentTransaction } from "./payclient";
import { base58, signAndSend, type Connected } from "./wallet";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const TOKEN_KEY = "sg_session";

type Status = { wallet: string | null; active: boolean; paidUntil: number | null; telegramLinked: boolean; botUsername: string | null; lastCheckAt: number | null; checks: number; alerts: number; priceUsd: number };
type Quote = { token: string; display: string; baseUnits: string };
type QuoteSet = { quoteId: string; usd: string; memo: string; expiresAt: number; quotes: Quote[]; treasury: string };

let connected: Connected | null = null;
let token: string | null = null;
let status: Status | null = null;
let pollTimer: number | null = null;
let guardAvailable: boolean | null = null;

function loadToken(wallet: string): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return j.wallet === wallet && typeof j.token === "string" ? j.token : null;
  } catch { return null; }
}
function saveToken(wallet: string, t: string | null): void {
  try { t ? localStorage.setItem(TOKEN_KEY, JSON.stringify({ wallet, token: t })) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

async function api<T = any>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 401 && token) { token = null; saveToken(connected?.address ?? "", null); }
  if (!r.ok) { const e: any = new Error(j.message || j.error || `HTTP ${r.status}`); e.code = j.error; e.status = r.status; throw e; }
  return j as T;
}

function note(text: string, kind: "" | "busy" | "err" | "ok" = ""): void {
  const el = $("#gstatus");
  el.textContent = text;
  el.className = `status ${kind}`;
}

/** Called by main.ts whenever the connection changes. `null` hides the card. */
export async function setGuardWallet(c: Connected | null): Promise<void> {
  connected = c;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const card = $("#guard");
  if (!c) { card.hidden = true; token = null; status = null; return; }
  // The card only makes sense where the guard is configured (session secret set on the Worker).
  if (guardAvailable === null) {
    try { guardAvailable = Boolean(((await (await fetch("/health")).json()) as any)?.guard); } catch { guardAvailable = false; }
  }
  if (!guardAvailable) { card.hidden = true; return; }
  card.hidden = false;
  token = loadToken(c.address);
  status = null;
  note("");
  if (token) {
    try { status = await api<Status>("/api/guard"); } catch { /* expired token: shows the sign-in button */ }
  }
  render();
}

function render(): void {
  const box = $("#gbody");
  if (!connected) return;
  if (!token || !status) {
    box.innerHTML = `<p>Get a Telegram message within the hour when something in this wallet changes for the worse: a new approval, a nonce account, a changed stake authority, a phishing airdrop, or the wallet account itself being taken over. <b>US$4.99 a year</b>, paid in USDC, SOL or SKR from this wallet.</p>
<p class="small muted">Signing in is a signature on a short message, not a transaction: it moves nothing and costs nothing.</p>
<button id="gsignin" class="btn primary">Sign in to set it up</button>`;
    $("#gsignin").addEventListener("click", signIn);
    return;
  }
  const s = status;
  const lines: string[] = [];
  if (s.active) {
    lines.push(`<p class="okline">✅ Guard active until <b>${new Date(s.paidUntil!).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</b>. ${s.checks ? `Checked ${s.checks} time${s.checks === 1 ? "" : "s"}, ${s.alerts} alert${s.alerts === 1 ? "" : "s"} sent.` : "First check within the hour."}</p>`);
  } else {
    lines.push(`<p>Get a Telegram message within the hour when something in this wallet changes for the worse. <b>US$${s.priceUsd.toFixed(2)} a year</b>, paid in USDC, SOL or SKR from this wallet.</p>`);
  }
  if (s.telegramLinked) {
    lines.push(`<p>📨 Telegram linked. <button id="gunlink" class="linkbtn">Unlink</button></p>`);
  } else if (s.botUsername) {
    lines.push(`<p>Step 1: <button id="glink" class="btn small">Link Telegram</button> <span class="small muted">opens the SealGuard bot; press Start there.</span></p>`);
  } else {
    lines.push(`<p class="small muted">Telegram alerts aren't switched on for this deployment yet.</p>`);
  }
  if (!s.active) lines.push(`<p>Step 2: <button id="gpay" class="btn primary small"${s.telegramLinked ? "" : " disabled"}>Pay US$${s.priceUsd.toFixed(2)} for a year</button></p><div id="gquotes"></div>`);
  else lines.push(`<p><button id="gpay" class="btn small">Extend by a year (US$${s.priceUsd.toFixed(2)})</button></p><div id="gquotes"></div>`);
  lines.push(`<p class="small muted">Alerts go only to your Telegram. SealGuard stores the wallet address, the chat id and a summary of the last check; nothing else.</p>`);
  box.innerHTML = lines.join("");
  $("#glink")?.addEventListener("click", linkTelegram);
  $("#gunlink")?.addEventListener("click", unlinkTelegram);
  $("#gpay")?.addEventListener("click", startPayment);
}

async function signIn(): Promise<void> {
  if (!connected) return;
  const sm: any = connected.wallet.features["solana:signMessage"];
  if (!sm) { note("This wallet can't sign messages; try Phantom, Solflare or Backpack.", "err"); return; }
  try {
    note("Preparing the sign-in message…", "busy");
    const { nonce, issuedAt, message } = await api<{ nonce: string; issuedAt: string; message: string }>("/api/auth/nonce", { wallet: connected.address });
    note("Waiting for your signature…", "busy");
    const [out] = await sm.signMessage({ account: connected.account, message: new TextEncoder().encode(message) });
    const signature = base58(out.signature);
    const r = await api<{ token: string }>("/api/auth/verify", { wallet: connected.address, nonce, issuedAt, signature });
    token = r.token;
    saveToken(connected.address, token);
    status = await api<Status>("/api/guard");
    note("");
    render();
  } catch (e: any) {
    note(e?.message || "Sign-in failed", "err");
  }
}

async function linkTelegram(): Promise<void> {
  try {
    const r = await api<{ url: string }>("/api/guard/link", {});
    window.open(r.url, "_blank", "noopener");
    note("Press Start in Telegram. This page updates by itself once the bot has linked.", "busy");
    const started = Date.now();
    pollTimer = window.setInterval(async () => {
      try {
        status = await api<Status>("/api/guard");
        if (status.telegramLinked || Date.now() - started > 3 * 60_000) {
          clearInterval(pollTimer!); pollTimer = null;
          note(status.telegramLinked ? "Telegram linked." : "", status.telegramLinked ? "ok" : "");
          render();
        }
      } catch { /* keep polling */ }
    }, 3000);
  } catch (e: any) {
    note(e?.message || "Couldn't start the link", "err");
  }
}

async function unlinkTelegram(): Promise<void> {
  try { await api("/api/guard/unlink", {}); status = await api<Status>("/api/guard"); render(); } catch (e: any) { note(e?.message || "Failed", "err"); }
}

async function startPayment(): Promise<void> {
  try {
    note("Getting today's prices…", "busy");
    const q = await api<QuoteSet>("/api/guard/quote", {});
    note("");
    const box = $("#gquotes");
    box.innerHTML = `<p class="small">Pay with:</p><div class="wallets">${q.quotes.map((x) => `<button class="wbtn" data-token="${x.token}">${esc(x.display)} ${x.token}</button>`).join("")}</div><p class="small muted">The price is held for 15 minutes. One transaction from this wallet to 2C Studio's treasury with a memo; your wallet shows the exact amount before you sign.</p>`;
    box.querySelectorAll<HTMLButtonElement>(".wbtn").forEach((b) => b.addEventListener("click", () => pay(q, b.dataset.token!)));
  } catch (e: any) {
    note(e?.message || "Couldn't get a price", "err");
  }
}

async function pay(q: QuoteSet, tokenName: string): Promise<void> {
  if (!connected) return;
  const quote = q.quotes.find((x) => x.token === tokenName);
  if (!quote) return;
  try {
    note(`Preparing the ${tokenName} payment…`, "busy");
    const owner = new PublicKey(connected.address);
    const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx = paymentTransaction(tokenName, BigInt(quote.baseUnits), owner, new PublicKey(q.treasury), q.memo, bh.value.blockhash, bh.value.lastValidBlockHeight);
    const sim = await rpc<any>("simulateTransaction", [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
    if (sim?.value?.err) throw new Error(`The network rejected the payment in simulation (${JSON.stringify(sim.value.err)}). Not enough ${tokenName}? Nothing was sent.`);
    note("Waiting for your signature…", "busy");
    const sig = await signAndSend(connected, tx, async (raw) => rpc<string>("sendTransaction", [Buffer.from(raw).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]));
    note("Payment sent. Waiting for the network to confirm it…", "busy");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        await api("/api/guard/pay", { quoteId: q.quoteId, token: tokenName, signature: sig });
        status = await api<Status>("/api/guard");
        note("Paid. The guard is on.", "ok");
        render();
        return;
      } catch (e: any) {
        if (e.status !== 404 && e.status !== 503) throw e;
      }
    }
    note(`The payment was sent (${sig.slice(0, 8)}…) but hasn't been seen yet. Reload in a minute; if the guard still isn't on, write to support@2cstudio.app with that signature.`, "err");
  } catch (e: any) {
    note(e?.message || "Payment failed; nothing was charged.", "err");
  }
}
