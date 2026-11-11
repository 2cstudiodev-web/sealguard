import "./polyfill";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { fetchScanInput, rpc } from "./rpc";
import { CLOSE_FEE_BPS, closeFee, scan, shortKey, solWithUsd, type Action, type Finding, type ScanInput, type ScanResult, type Severity } from "./scan";
import { buildTransaction, describeAction, describeFee, groupFee, packActions, TXS_PER_APPROVAL } from "./tx";
import { connect, disconnect, listWallets, onWalletsChange, registerMobile, signAndSendMany, type Connected } from "./wallet";
import { isGuardMember, onGuardChange, setGuardWallet } from "./guard";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const explorer = (k: string) => `https://solscan.io/account/${k}`;

/** The wallet being looked at: connected (can fix) or just an address someone pasted (read-only). */
let address: string | null = null;
let connected: Connected | null = null;
let result: ScanResult | null = null;
let selected = new Set<number>();
let lastInput: ScanInput | null = null;

/** Members (active guard, signed in) close empty accounts with no fee. */
const feeBps = () => (isGuardMember() ? 0 : CLOSE_FEE_BPS);

/**
 * Links from the guard's Telegram messages: ?fix=<account> selects the fix for that account, ?claim=1 selects
 * every empty-account close. Applied once this wallet is connected and scanned.
 */
const params = new URLSearchParams(location.search);
let pendingFix: { claim: boolean; fix: string | null } | null = params.get("claim") === "1" || params.get("fix") ? { claim: params.get("claim") === "1", fix: params.get("fix") } : null;

function setStatus(text: string, kind: "" | "busy" | "err" = ""): void {
  const el = $("#status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

function renderWallets(): void {
  const box = $("#wallets");
  const ws = listWallets();
  $("#walletpickhead").hidden = ws.length === 0;
  if (!ws.length) {
    box.innerHTML = `<p class="muted">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, or open this page inside your wallet app's browser. On a Seeker, open it in any browser and pick Seed Vault.</p>`;
    return;
  }
  box.innerHTML = ws.map((w, i) => `<button class="wbtn" data-i="${i}"><img src="${esc(w.icon)}" alt="" width="22" height="22"> ${esc(w.name)}</button>`).join("");
  box.querySelectorAll<HTMLButtonElement>(".wbtn").forEach((b) => b.addEventListener("click", () => doConnect(ws[Number(b.dataset.i)])));
}

/**
 * The Connect button: with one wallet in the browser (or Seed Vault on a Seeker) it connects straight away;
 * with several it opens the list of the ones it found; with none it explains what to install.
 */
function openWalletPicker(): void {
  const ws = listWallets();
  if (ws.length === 1) { void doConnect(ws[0]); return; }
  renderWallets();
  $("#walletpick").hidden = false;
}

function showSession(): void {
  $("#connect").hidden = true;
  $("#session").hidden = false;
  $("#addr").textContent = address ?? "";
  $("#mode").textContent = connected ? "" : "(read-only: connect this wallet to apply fixes)";
  $("#navconnect").textContent = connected ? shortKey(connected.address) : "Connect wallet";
}

/** The Connect button in the nav: opens the wallet list in the hero (or, once connected, jumps to the report). */
function navConnect(): void {
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (connected) return;
  if ($("#connect").hidden) void doDisconnect();
  openWalletPicker();
}

async function doConnect(w: import("@wallet-standard/base").Wallet): Promise<void> {
  try {
    setStatus("Waiting for the wallet…", "busy");
    connected = await connect(w);
    address = connected.address;
    showSession();
    setStatus("");
    void setGuardWallet(connected);
    await doScan();
  } catch (e: any) {
    setStatus(e?.message || "The wallet didn't connect", "err");
  }
}

function doScanAddress(ev: Event): void {
  ev.preventDefault();
  const raw = $<HTMLInputElement>("#addrinput").value.trim();
  try {
    const pk = new PublicKey(raw);
    if (!PublicKey.isOnCurve(pk.toBytes())) throw new Error("not a wallet");
    address = pk.toBase58();
  } catch {
    setStatus("That doesn't look like a Solana wallet address.", "err");
    return;
  }
  connected = null;
  void setGuardWallet(null);
  showSession();
  setStatus("");
  void doScan();
}

async function doDisconnect(): Promise<void> {
  if (connected) await disconnect(connected);
  void setGuardWallet(null);
  connected = null; address = null; result = null; lastInput = null; selected = new Set();
  $("#session").hidden = true;
  $("#report").hidden = true;
  $("#connect").hidden = false;
  $("#walletpick").hidden = true;
  $("#navconnect").textContent = "Connect wallet";
  setStatus("");
}

async function doScan(): Promise<void> {
  if (!address) return;
  $("#scanbtn").toggleAttribute("disabled", true);
  $("#report").hidden = true;
  try {
    const input = await fetchScanInput(address, (s) => setStatus(`${s}…`, "busy"));
    lastInput = input;
    result = scan(input, { closeFeeBps: feeBps() });
    void reportStat("scan");
    selected = new Set();
    setStatus("");
    renderReport();
    applyPendingFix();
    $("#report").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e: any) {
    setStatus(`Scan failed: ${e?.message || e}`, "err");
  } finally {
    $("#scanbtn").toggleAttribute("disabled", false);
  }
}

const SEV_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", ok: "Tidy-up" };

function renderReport(): void {
  if (!result) return;
  const r = result;
  $("#report").hidden = false;
  const score = $("#score");
  score.textContent = String(r.score);
  score.className = `score ${r.score >= 90 ? "good" : r.score >= 60 ? "meh" : "bad"}`;
  const parts: string[] = [];
  (["critical", "high", "medium", "low", "ok"] as Severity[]).forEach((s) => { if (r.counts[s]) parts.push(`${r.counts[s]} ${SEV_LABEL[s].toLowerCase()}`); });
  $("#summary").textContent = r.findings.length
    ? `${r.findings.length} finding${r.findings.length > 1 ? "s" : ""}: ${parts.join(", ")}.`
    : "Nothing to flag. Nobody but you can move your tokens, no phishing tokens, no stray nonce or stake authorities.";
  const reclaim = $("#reclaim");
  reclaim.hidden = r.reclaim.accounts === 0;
  const plural = r.reclaim.accounts === 1 ? "" : "s";
  reclaim.textContent = !r.reclaim.accounts ? ""
    : r.reclaim.fee ? `You can get ${solWithUsd(r.reclaim.net, r.solPriceUsd)} back by closing ${r.reclaim.accounts} empty token account${plural} (${solWithUsd(r.reclaim.lamports, null)} of rent, less SealGuard's ${CLOSE_FEE_BPS / 100}% fee).`
    : `You can get ${solWithUsd(r.reclaim.net, r.solPriceUsd)} back by closing ${r.reclaim.accounts} empty token account${plural}, with no fee because this wallet has the guard.`;
  $("#checked").textContent = `Looked at ${r.checked.tokenAccounts} token accounts, ${r.checked.mints} Token-2022 mints, ${r.checked.stakes} stake accounts and ${r.checked.nonces} nonce accounts.` + (r.warnings.length ? ` ${r.warnings.join(" ")}` : "");

  const list = $("#findings");
  list.innerHTML = groupFindings(r.findings).map((g) => (g.length === 1 ? card(r.findings[g[0]], g[0]) : groupCard(r.findings, g))).join("");
  list.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
    const idx = String(cb.dataset.i).split(",").map(Number);
    for (const i of idx) { if (cb.checked) selected.add(i); else selected.delete(i); }
    restoreChecks();
    renderFixBar();
  }));
  restoreChecks();
  list.querySelectorAll<HTMLButtonElement>(".more").forEach((b) => b.addEventListener("click", () => {
    const ul = b.nextElementSibling as HTMLElement;
    ul.hidden = !ul.hidden;
    b.textContent = ul.hidden ? b.dataset.show! : "Hide the list";
  }));
  renderFixBar();
}

/** Ticks the boxes of what's selected (after a re-render, e.g. when membership changes the prices). */
function restoreChecks(): void {
  $("#findings").querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
    const idx = String(cb.dataset.i).split(",").map(Number);
    const n = idx.filter((i) => selected.has(i)).length;
    cb.checked = idx.length > 0 && n === idx.length;
    cb.indeterminate = n > 0 && n < idx.length;
  });
}

function applyPendingFix(): void {
  if (!pendingFix || !connected || !result) return;
  const p = pendingFix;
  pendingFix = null;
  history.replaceState(null, "", location.pathname);
  let n = 0;
  result.findings.forEach((f, i) => {
    if (!f.action) return;
    if ((p.claim && f.action.kind === "close" && !f.keep) || (p.fix && f.accounts.includes(p.fix))) { selected.add(i); n++; }
  });
  restoreChecks();
  renderFixBar();
  setStatus(n ? "Selected from your SealGuard message. Check it and press Fix selected." : "Nothing from that link needs fixing any more.");
}

/** Findings of one check and severity are shown as one card once there are four or more (a whale wallet can have hundreds). */
const GROUP_FROM = 4;
function groupFindings(fs: Finding[]): number[][] {
  const groups = new Map<string, number[]>();
  fs.forEach((f, i) => {
    const key = `${f.check}:${f.severity}`;
    groups.get(key)?.push(i) ?? groups.set(key, [i]);
  });
  const out: number[][] = [];
  const done = new Set<string>();
  fs.forEach((f, i) => {
    const key = `${f.check}:${f.severity}`;
    const g = groups.get(key)!;
    if (g.length < GROUP_FROM) { out.push([i]); return; }
    if (!done.has(key)) { done.add(key); out.push(g); }
  });
  return out;
}

const GROUP_TITLE: Record<string, (n: number) => string> = {
  frozen: (n) => `${n} of your token accounts are frozen by their issuers`,
  empty: (n) => `${n} empty token accounts: ${solWithUsd(result ? result.reclaim.net : 0, result?.solPriceUsd)} back to you`,
  permanentDelegate: (n) => `${n} tokens whose issuer can take them back`,
  closeAuthority: (n) => `${n} token accounts someone else may close once empty`,
  delegate: (n) => `${n} approvals on your token accounts`,
  mintExtensions: (n) => `${n} tokens with restrictions built in`,
  phishing: (n) => `${n} tokens that look like phishing airdrops`,
  nonce: (n) => `${n} durable nonce accounts tied to your wallet`,
  stake: (n) => `${n} stake accounts with someone else's authority`,
};

function groupCard(fs: Finding[], idx: number[]): string {
  const first = fs[idx[0]];
  const n = idx.length;
  const withAction = idx.filter((i) => fs[i].action);
  const recommended = withAction.filter((i) => !fs[i].keep);
  const kept = withAction.length - recommended.length;
  const off = connected ? "" : " disabled";
  const items = idx.map((i) => {
    const f = fs[i];
    const links = f.accounts.map((a) => `<a href="${explorer(a)}" target="_blank" rel="noopener">${shortKey(a)}</a>`).join(" · ");
    const box = f.action ? `<input type="checkbox" class="itembox" data-i="${i}"${off}> ` : "";
    const why = f.keep ? ` <span class="keep">Left unticked: ${esc(f.keep)}</span>` : "";
    return `<li><label>${box}${esc(f.title)}</label> · ${links}${why}</li>`;
  }).join("");
  const label = recommended.length
    ? `${esc(actionLabel(fs[withAction[0]].action!))} (${recommended.length === withAction.length ? `all ${recommended.length}` : `${recommended.length} of ${withAction.length}`})`
    : "";
  const action = recommended.length
    ? `<label class="act"><input type="checkbox" class="groupbox" data-i="${recommended.join(",")}"${off}> ${label}</label>${kept ? `<p class="small muted">${kept} left unticked on purpose; open the list to see why or to tick them yourself.</p>` : ""}`
    : withAction.length ? `<p class="small muted">All ${withAction.length} are left unticked on purpose; open the list to see why or to tick them yourself.</p>` : "";
  const show = `Show all ${n}`;
  return `<div class="card sev-${first.severity}"><div class="sev">${SEV_LABEL[first.severity]}</div><h3>${esc((GROUP_TITLE[first.check] ?? ((k: number) => `${k} findings`))(n))}</h3><p>${esc(first.detail)}</p><button class="more linkbtn" data-show="${show}">${show}</button><ul class="grouplist small" hidden>${items}</ul>${action}</div>`;
}

function card(f: Finding, i: number): string {
  const links = f.accounts.map((a) => `<a href="${explorer(a)}" target="_blank" rel="noopener">${shortKey(a)}</a>`).join(" · ");
  const action = f.action ? `<label class="act"><input type="checkbox" data-i="${i}"${connected ? "" : " disabled"}> ${esc(actionLabel(f.action))}</label>${f.keep ? `<p class="small keep">Left unticked: ${esc(f.keep)}</p>` : ""}` : "";
  return `<div class="card sev-${f.severity}"><div class="sev">${SEV_LABEL[f.severity]}</div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p><p class="links">${links}</p>${action}</div>`;
}

function actionLabel(a: Action): string {
  switch (a.kind) {
    case "revoke": return "Revoke this approval";
    case "close": return "Close the account and take the rent back";
    case "burnClose": return "Burn it and close the account";
    case "withdrawNonce": return "Withdraw the nonce account to my wallet";
  }
}

function renderFixBar(): void {
  const bar = $("#fixbar");
  const n = selected.size;
  bar.hidden = n === 0;
  $("#fixcount").textContent = `${n} action${n === 1 ? "" : "s"} selected`;
  const acts = [...selected].map((i) => result!.findings[i].action!).filter(Boolean);
  // The full list is there for anyone who wants to read every instruction, but folded: sixteen "close empty
  // account" lines pushed the button off the screen.
  const list = $("#fixlist");
  const bps = feeBps();
  const fee = acts.length && connected ? packActions(acts, new PublicKey(connected.address), { feeBps: bps }).reduce((sum, g) => sum + groupFee(g, bps), 0) : 0;
  list.innerHTML = acts.map((a) => `<li>${esc(describeAction(a))}</li>`).join("") + (fee ? `<li>${esc(describeFee(fee))}</li>` : "");
  const closing = acts.filter((a) => a.kind === "close").reduce((sum, a) => sum + (a.kind === "close" ? a.lamports : 0), 0);
  const price = result?.solPriceUsd ?? null;
  $("#fixfee").textContent = !closing ? "All selected fixes are free."
    : bps ? `Closing empty accounts returns ${solWithUsd(closing - closeFee(closing, bps), price)} to you after SealGuard's ${bps / 100}% fee (${solWithUsd(closeFee(closing, bps), price)}). Revoking and burning are free. Free for wallets with the guard.`
    : `Closing empty accounts returns ${solWithUsd(closing, price)} to you. No fee: this wallet has the guard.`;
  list.hidden = true;
  const burning = acts.some((a) => a.kind === "burnClose");
  $("#burnackrow").hidden = !burning;
  if (!burning) $<HTMLInputElement>("#burnack").checked = false;
  syncFixButton();
  const toggle = $<HTMLButtonElement>("#fixtoggle");
  toggle.hidden = acts.length === 0;
  toggle.textContent = `Show what will be sent (${list.children.length})`;
}

/** Fix stays off while a burn is selected and not acknowledged. */
function syncFixButton(): void {
  const needsAck = !$("#burnackrow").hidden && !$<HTMLInputElement>("#burnack").checked;
  $("#fixbtn").toggleAttribute("disabled", needsAck);
}

async function doFix(): Promise<void> {
  if (!connected || !result) return;
  const actions = [...selected].sort((a, b) => a - b).map((i) => result!.findings[i].action!).filter(Boolean);
  if (!actions.length) return;
  const owner = new PublicKey(connected.address);
  const bps = feeBps();
  const groups = packActions(actions, owner, { feeBps: bps });
  const rounds = Math.ceil(groups.length / TXS_PER_APPROVAL);
  const log = $("#fixlog");
  log.innerHTML = "";
  $("#fixbtn").toggleAttribute("disabled", true);
  let sent = 0, failed = 0, closes = 0, closeLamports = 0, feeLamports = 0;
  try {
    for (let r = 0; r < rounds; r++) {
      const chunk = groups.slice(r * TXS_PER_APPROVAL, (r + 1) * TXS_PER_APPROVAL);
      const label = rounds > 1 ? `Batch ${r + 1} of ${rounds}` : chunk.length > 1 ? `${chunk.length} transactions` : "Transaction";
      setStatus(`${label}: preparing…`, "busy");
      const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const txs = chunk.map((g) => buildTransaction(g, owner, bh.value.blockhash, bh.value.lastValidBlockHeight, { feeBps: bps }));
      const sims = await Promise.all(txs.map((tx) => rpc<any>("simulateTransaction", [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }])));
      const bad = sims.findIndex((sim) => sim?.value?.err);
      if (bad >= 0) throw new Error(`The network rejected a transaction in simulation: ${JSON.stringify(sims[bad].value.err)}. Nothing in this batch was sent.`);
      setStatus(`${label}: waiting for your approval in the wallet (${chunk.length} transaction${chunk.length === 1 ? "" : "s"})…`, "busy");
      const results = await signAndSendMany(connected, txs, async (raw) => rpc<string>("sendTransaction", [Buffer.from(raw).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]));
      results.forEach((res, k) => {
        const g = chunk[k];
        if (res.ok) {
          sent++;
          for (const a of g) if (a.kind === "close") { closes++; closeLamports += a.lamports; }
          feeLamports += groupFee(g, bps);
          log.innerHTML += `<li>Sent <a href="https://solscan.io/tx/${res.signature}" target="_blank" rel="noopener">${res.signature.slice(0, 8)}…</a> (${g.length} action${g.length === 1 ? "" : "s"})</li>`;
        } else {
          failed++;
          log.innerHTML += `<li class="err">Not sent (${g.length} action${g.length === 1 ? "" : "s"}): ${esc(res.error)}</li>`;
        }
      });
      if (results.length < chunk.length || results.every((x) => !x.ok)) break;
    }
    void reportStat("fix", { closes, lamports: closeLamports, fee: feeLamports });
    setStatus(failed ? `${sent} sent, ${failed} not sent. Rescanning…` : "Done. Rescanning…", failed ? "err" : "busy");
    await new Promise((r) => setTimeout(r, 2500));
    await doScan();
  } catch (e: any) {
    setStatus(e?.message || "Something went wrong; nothing more was sent.", "err");
  } finally {
    syncFixButton();
  }
}

/** Anonymous counters for 2C Studio (no address): how many scans, how many accounts closed, how much fee. */
async function reportStat(kind: "scan" | "fix", data: Record<string, number> = {}): Promise<void> {
  try { await fetch("/api/stat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, ...data }), keepalive: true }); } catch { /* best effort */ }
}

registerMobile();
// Membership changes the fee on closing empty accounts: re-price the report already on screen.
onGuardChange(() => {
  if (!lastInput || !connected) return;
  result = scan(lastInput, { closeFeeBps: feeBps() });
  renderReport();
});
if (pendingFix) setStatus("Connect the wallet this message was about to see the fix.");
onWalletsChange(renderWallets);
$("#connectbtn").addEventListener("click", openWalletPicker);
$("#navconnect").addEventListener("click", navConnect);
$("#addrform").addEventListener("submit", doScanAddress);
$("#scanbtn").addEventListener("click", doScan);
$("#disconnect").addEventListener("click", doDisconnect);
$("#fixbtn").addEventListener("click", doFix);
$("#burnack").addEventListener("change", syncFixButton);
$("#fixtoggle").addEventListener("click", () => {
  const list = $("#fixlist");
  list.hidden = !list.hidden;
  $("#fixtoggle").textContent = list.hidden ? `Show what will be sent (${list.children.length})` : "Hide the list";
});
