// The guard card: sign in with the wallet, link Telegram, pay for a year, see the status.
import { PublicKey } from "@solana/web3.js";
import { rpc } from "./rpc";
import { paymentTransaction } from "./payclient";
import { base58, signAndSend, type Connected } from "./wallet";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const TOKEN_KEY = "sg_session";
/** The guard's yearly price as shown before sign-in; after sign-in the server's figure is used. */
const DEFAULT_PRICE_USD = 49;
/** "US$49" for whole dollars, "US$4.99" otherwise. */
const usd = (n: number) => `US$${Number.isInteger(n) ? n : n.toFixed(2)}`;

type Status = { wallet: string | null; active: boolean; paidUntil: number | null; telegramLinked: boolean; botUsername: string | null; lastCheckAt: number | null; checks: number; alerts: number; priceUsd: number };
type Quote = { token: string; display: string; baseUnits: string };
type QuoteSet = { quoteId: string; usd: string; memo: string; expiresAt: number; quotes: Quote[]; treasury: string; test?: boolean };

let connected: Connected | null = null;
let token: string | null = null;
let status: Status | null = null;
let pollTimer: number | null = null;
let guardAvailable: boolean | null = null;
const listeners: (() => void)[] = [];
let lastMember = false;
/** The connected wallet, when the server says its guard is active (looked up on connect, no sign-in needed). */
let memberWallet: string | null = null;

/**
 * True when the connected wallet's guard is active (members close, burn and sell with no fee): either signed in, or
 * known from the public lookup on connect, so a member who only connected isn't charged.
 */
export function isGuardMember(): boolean {
  if (!connected) return false;
  return Boolean((token && status?.active && status.wallet === connected.address) || memberWallet === connected.address);
}
/** True when this deployment offers the guard to the connected wallet (the card is on screen). */
export function guardOffered(): boolean {
  return Boolean(connected && guardAvailable);
}
/** The yearly price to show: the server's figure once signed in, otherwise the default. */
export function guardPriceUsd(): number {
  return status?.priceUsd ?? DEFAULT_PRICE_USD;
}
/** From the upsell: bring the guard card into view, sign in if needed, then open the payment choices. */
export async function buyGuard(): Promise<void> {
  $("#guard").scrollIntoView({ behavior: "smooth", block: "start" });
  if (!token || !status) await signIn();
  if (token && status && !status.active) await startPayment();
}
/** Sign out: forget this browser's SealGuard sign-in (the wallet itself is disconnected by main.ts). */
export function forgetGuardSession(): void {
  if (connected) saveToken(connected.address, null);
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  token = null;
  status = null;
}

async function lookUpMember(wallet: string): Promise<void> {
  try {
    const r = await fetch(`/api/guard/member?wallet=${encodeURIComponent(wallet)}`);
    const j: any = r.ok ? await r.json() : null;
    if (connected?.address !== wallet) return; // the wallet changed meanwhile
    memberWallet = j?.active ? wallet : null;
  } catch { /* unknown: the fee stays until they sign in */ }
  notifyChange();
}

/** main.ts re-prices the report when membership changes. */
export function onGuardChange(cb: () => void): void {
  listeners.push(cb);
}
function notifyChange(): void {
  const m = isGuardMember();
  if (m !== lastMember) { lastMember = m; listeners.forEach((f) => f()); }
}

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
  hideLinkHelp();
  if (!c) { card.hidden = true; token = null; status = null; memberWallet = null; notifyChange(); return; }
  void lookUpMember(c.address);
  // The card only makes sense where the guard is configured (session secret set on the Worker).
  if (guardAvailable === null) {
    try { guardAvailable = Boolean(((await (await fetch("/health")).json()) as any)?.guard); } catch { guardAvailable = false; }
  }
  if (!guardAvailable) { card.hidden = true; notifyChange(); return; }
  card.hidden = false;
  token = loadToken(c.address);
  status = null;
  note("");
  if (token) {
    try { status = await api<Status>("/api/guard"); } catch { /* expired token: shows the sign-in button */ }
  }
  render();
}

const PITCH = "For about 13¢ a day, SealGuard checks this wallet every hour and messages you on Telegram when something changes for the worse: a new approval, a nonce account, a changed stake authority, a phishing airdrop, or the wallet account itself being taken over. It's an early warning, not a shield: it can't stop a transaction.";

function render(): void {
  const box = $("#gbody");
  if (!connected) return;
  notifyChange();
  if (!token || !status) {
    box.innerHTML = `<p>${PITCH} Closing accounts, burning NFTs and selling small balances are also fee-free with it. <b>${usd(DEFAULT_PRICE_USD)} a year</b>, paid in USDC, SOL or SKR from this wallet.</p>
<p class="small muted">Signing in is a signature on a short message, not a transaction: it moves nothing and costs nothing.</p>
<button id="gsignin" class="btn primary">Sign in to set it up</button>`;
    $("#gsignin").addEventListener("click", signIn);
    return;
  }
  const s = status;
  const lines: string[] = [];
  if (s.active) {
    lines.push(`<p class="okline">✅ Guard active until <b>${new Date(s.paidUntil!).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</b>. ${s.checks ? `Checked ${s.checks} time${s.checks === 1 ? "" : "s"}, ${s.alerts} alert${s.alerts === 1 ? "" : "s"} sent.` : s.telegramLinked ? "First check within the hour." : ""}</p>`);
    if (s.telegramLinked) {
      lines.push(`<p>📨 Telegram linked. <button id="gunlink" class="linkbtn">Unlink</button> · <button id="gtest" class="linkbtn" type="button">Send a test alert</button></p>`);
    } else if (s.botUsername) {
      lines.push(`<p>Step 2: <button id="glink" class="btn primary small">Link Telegram</button> <span class="small muted">opens the SealGuard bot; press Start there. Alerts start once it's linked.</span></p>`);
    } else {
      lines.push(`<p class="small muted">Telegram alerts aren't switched on for this deployment yet.</p>`);
    }
    lines.push(`<p><button id="gpay" class="btn small">Extend by a year (${usd(s.priceUsd)})</button></p><div id="gquotes"></div>`);
  } else {
    lines.push(`<p>${PITCH} Closing accounts, burning NFTs and selling small balances are also fee-free with it. <b>${usd(s.priceUsd)} a year</b>, paid in USDC, SOL or SKR from this wallet.</p>`);
    lines.push(`<p>Step 1: <button id="gpay" class="btn primary small">Pay ${usd(s.priceUsd)} for a year</button></p><div id="gquotes"></div>`);
    lines.push(`<p class="small muted">Step 2, once paid: link Telegram, where the alerts arrive.</p>`);
  }
  lines.push(`<p class="small muted">Alerts go only to your Telegram. SealGuard stores the wallet address, the chat id and a summary of the last check; nothing else.</p>`);
  box.innerHTML = lines.join("");
  $("#glink")?.addEventListener("click", linkTelegram);
  $("#gunlink")?.addEventListener("click", unlinkTelegram);
  $("#gtest")?.addEventListener("click", sendTestAlert);
  $("#gpay")?.addEventListener("click", startPayment);
}

/** Has the wallet sign SealGuard's sign-in message (a signature, not a transaction). */
async function signProof(waiting: string): Promise<{ nonce: string; issuedAt: string; signature: string }> {
  const c = connected!;
  const sm: any = c.wallet.features["solana:signMessage"];
  if (!sm) throw new Error("This wallet can't sign messages; try Phantom, Solflare or Backpack.");
  note("Preparing the sign-in message…", "busy");
  const { nonce, issuedAt, message } = await api<{ nonce: string; issuedAt: string; message: string }>("/api/auth/nonce", { wallet: c.address });
  note(waiting, "busy");
  const [out] = await sm.signMessage({ account: c.account, message: new TextEncoder().encode(message) });
  return { nonce, issuedAt, signature: base58(out.signature) };
}

/** Link and unlink change where alerts go: when the sign-in is older than 10 minutes the server asks for one more
 *  signature, and this signs it and retries. */
async function freshApi<T>(path: string): Promise<T> {
  const keep = (r: any) => { if (typeof r?.token === "string" && connected) { token = r.token; saveToken(connected.address, r.token); } return r as T; };
  try {
    return keep(await api<T>(path, {}));
  } catch (e: any) {
    if (e?.code !== "resign") throw e;
    const proof = await signProof("Changing where alerts go needs one more signature. Waiting for it…");
    return keep(await api<T>(path, { proof }));
  }
}

async function signIn(): Promise<void> {
  if (!connected) return;
  try {
    const { nonce, issuedAt, signature } = await signProof("Waiting for your signature…");
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
    const r = await freshApi<{ url: string; code: string; expiresAt: number }>("/api/guard/link");
    openTelegram(r.url, status?.botUsername ?? "seal_guard_bot", r.code);
    note("Press Start in Telegram. This page updates by itself once the bot has linked.", "busy");
    showLinkHelp(r.code);
    if (pollTimer) clearInterval(pollTimer);
    const until = r.expiresAt ?? Date.now() + 30 * 60_000;
    pollTimer = window.setInterval(async () => {
      try {
        status = await api<Status>("/api/guard");
        if (status.telegramLinked || Date.now() > until) {
          clearInterval(pollTimer!); pollTimer = null;
          note(status.telegramLinked ? "Telegram linked." : "The link code has expired. Press Link Telegram for a new one.", status.telegramLinked ? "ok" : "");
          if (status.telegramLinked) hideLinkHelp();
          render();
        }
      } catch { /* keep polling */ }
    }, 3000);
  } catch (e: any) {
    note(e?.message || "Couldn't start the link", "err");
  }
}

/**
 * Opens the bot with the link code. Phones hand t.me links straight to the Telegram app. On a computer the t.me
 * web page sits in between and its START BOT button has to launch the desktop app a second time, which browsers
 * (Brave in particular) can quietly block; the tg:// link goes to the desktop app directly. Either way the browser
 * may ask "Open Telegram?" first, and in the app the user presses START at the bottom of the chat.
 */
function openTelegram(webUrl: string, bot: string, code: string): void {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile) {
    window.location.href = webUrl;
    return;
  }
  const a = document.createElement("a");
  a.href = `tg://resolve?domain=${encodeURIComponent(bot)}&start=${encodeURIComponent(code)}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** For when the link doesn't open the Telegram app: the same /start command, to send by hand. */
function showLinkHelp(code: string): void {
  const box = $("#glinkhelp");
  const cmd = `/start ${code}`;
  const bot = status?.botUsername ?? "seal_guard_bot";
  // Telegram Web takes the same deep link through `tgaddr`, so it opens the bot with the start code ready.
  const web = `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(`tg://resolve?domain=${bot}&start=${code}`)}`;
  box.innerHTML = `<p>Telegram didn't open? <a class="btn small" href="${esc(web)}" target="_blank" rel="noopener">Open in Telegram Web</a></p>
<p>Or, in the Telegram app, open <b>@${esc(bot)}</b> and send:</p>
<p class="cmdline"><code id="glinkcmd">${esc(cmd)}</code> <button id="glinkcopy" class="btn small" type="button">Copy</button></p>
<p class="small muted">The code works for 30 minutes.</p>`;
  box.hidden = false;
  $("#glinkcopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      $("#glinkcopy").textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents($("#glinkcmd"));
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });
}

function hideLinkHelp(): void {
  const box = $("#glinkhelp");
  box.hidden = true;
  box.innerHTML = "";
}

async function sendTestAlert(): Promise<void> {
  try {
    note("Sending a test alert…", "busy");
    await api("/api/guard/test", {});
    note("Test alert sent. Check Telegram.", "ok");
  } catch (e: any) {
    note(e?.message || "Couldn't send the test alert", "err");
  }
}

async function unlinkTelegram(): Promise<void> {
  try { await freshApi("/api/guard/unlink"); status = await api<Status>("/api/guard"); render(); note("Unlinked. Telegram alerts have stopped.", "ok"); } catch (e: any) { note(e?.message || "Failed", "err"); }
}

async function startPayment(): Promise<void> {
  try {
    note("Getting today's prices…", "busy");
    const q = await api<QuoteSet>("/api/guard/quote", {});
    note("");
    const box = $("#gquotes");
    box.innerHTML = `${q.test ? `<p class="small keep">Test prices: this wallet is on the test list.</p>` : ""}<p class="small">Pay with:</p><div class="wallets">${q.quotes.map((x) => `<button class="wbtn" data-token="${x.token}">${esc(x.display)} ${x.token}</button>`).join("")}</div><p class="small muted">The price is held for 15 minutes. One transaction from this wallet to 2C Studio's treasury with a memo; your wallet shows the exact amount before you sign.</p>`;
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
