import "./polyfill";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { fetchScanInput, rpc } from "./rpc";
import { CLOSE_FEE_PERCENT, closeFee, scan, shortKey, solWithUsd, type Action, type Finding, type ScanResult, type Severity } from "./scan";
import { batchActions, buildTransaction, describeAction, describeFee, groupFee } from "./tx";
import { connect, disconnect, listWallets, onWalletsChange, registerMobile, signAndSend, type Connected } from "./wallet";
import { setGuardWallet } from "./guard";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const explorer = (k: string) => `https://solscan.io/account/${k}`;

/** The wallet being looked at: connected (can fix) or just an address someone pasted (read-only). */
let address: string | null = null;
let connected: Connected | null = null;
let result: ScanResult | null = null;
let selected = new Set<number>();

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
  connected = null; address = null; result = null; selected = new Set();
  $("#session").hidden = true;
  $("#report").hidden = true;
  $("#connect").hidden = false;
  $("#walletpick").hidden = true;
  setStatus("");
}

async function doScan(): Promise<void> {
  if (!address) return;
  $("#scanbtn").toggleAttribute("disabled", true);
  $("#report").hidden = true;
  try {
    const input = await fetchScanInput(address, (s) => setStatus(`${s}…`, "busy"));
    result = scan(input);
    selected = new Set();
    setStatus("");
    renderReport();
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
  reclaim.textContent = r.reclaim.accounts ? `You can get ${solWithUsd(r.reclaim.net, r.solPriceUsd)} back by closing ${r.reclaim.accounts} empty token account${r.reclaim.accounts === 1 ? "" : "s"} (${solWithUsd(r.reclaim.lamports, null)} of rent, less SealGuard's ${CLOSE_FEE_PERCENT}% fee).` : "";
  $("#checked").textContent = `Looked at ${r.checked.tokenAccounts} token accounts, ${r.checked.mints} Token-2022 mints, ${r.checked.stakes} stake accounts and ${r.checked.nonces} nonce accounts.` + (r.warnings.length ? ` ${r.warnings.join(" ")}` : "");

  const list = $("#findings");
  list.innerHTML = groupFindings(r.findings).map((g) => (g.length === 1 ? card(r.findings[g[0]], g[0]) : groupCard(r.findings, g))).join("");
  list.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
    const idx = String(cb.dataset.i).split(",").map(Number);
    for (const i of idx) { if (cb.checked) selected.add(i); else selected.delete(i); }
    renderFixBar();
  }));
  list.querySelectorAll<HTMLButtonElement>(".more").forEach((b) => b.addEventListener("click", () => {
    const ul = b.nextElementSibling as HTMLElement;
    ul.hidden = !ul.hidden;
    b.textContent = ul.hidden ? b.dataset.show! : "Hide the list";
  }));
  renderFixBar();
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
  const items = idx.map((i) => `<li>${esc(fs[i].title)} · ${fs[i].accounts.map((a) => `<a href="${explorer(a)}" target="_blank" rel="noopener">${shortKey(a)}</a>`).join(" · ")}</li>`).join("");
  const action = withAction.length
    ? `<label class="act"><input type="checkbox" data-i="${withAction.join(",")}"${connected ? "" : " disabled"}> ${esc(actionLabel(fs[withAction[0]].action!))} (all ${withAction.length})</label>`
    : "";
  const show = `Show all ${n}`;
  return `<div class="card sev-${first.severity}"><div class="sev">${SEV_LABEL[first.severity]}</div><h3>${esc((GROUP_TITLE[first.check] ?? ((k: number) => `${k} findings`))(n))}</h3><p>${esc(first.detail)}</p><button class="more linkbtn" data-show="${show}">${show}</button><ul class="grouplist small" hidden>${items}</ul>${action}</div>`;
}

function card(f: Finding, i: number): string {
  const links = f.accounts.map((a) => `<a href="${explorer(a)}" target="_blank" rel="noopener">${shortKey(a)}</a>`).join(" · ");
  const action = f.action ? `<label class="act"><input type="checkbox" data-i="${i}"${connected ? "" : " disabled"}> ${esc(actionLabel(f.action))}</label>` : "";
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
  const fee = batchActions(acts).reduce((sum, g) => sum + groupFee(g), 0);
  list.innerHTML = acts.map((a) => `<li>${esc(describeAction(a))}</li>`).join("") + (fee ? `<li>${esc(describeFee(fee))}</li>` : "");
  const closing = acts.filter((a) => a.kind === "close").reduce((sum, a) => sum + (a.kind === "close" ? a.lamports : 0), 0);
  $("#fixfee").textContent = closing ? `Closing empty accounts returns ${solWithUsd(closing - closeFee(closing), result?.solPriceUsd ?? null)} to you after SealGuard's ${CLOSE_FEE_PERCENT}% fee (${solWithUsd(closeFee(closing), result?.solPriceUsd ?? null)}). Revoking and burning are free.` : "All selected fixes are free.";
  list.hidden = true;
  const toggle = $<HTMLButtonElement>("#fixtoggle");
  toggle.hidden = acts.length === 0;
  toggle.textContent = `Show what will be sent (${list.children.length})`;
}

async function doFix(): Promise<void> {
  if (!connected || !result) return;
  const actions = [...selected].sort((a, b) => a - b).map((i) => result!.findings[i].action!).filter(Boolean);
  if (!actions.length) return;
  const owner = new PublicKey(connected.address);
  const groups = batchActions(actions);
  const log = $("#fixlog");
  log.innerHTML = "";
  $("#fixbtn").toggleAttribute("disabled", true);
  try {
    for (let g = 0; g < groups.length; g++) {
      setStatus(`Transaction ${g + 1} of ${groups.length}: preparing…`, "busy");
      const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const tx = buildTransaction(groups[g], owner, bh.value.blockhash, bh.value.lastValidBlockHeight);
      const sim = await rpc<any>("simulateTransaction", [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
      if (sim?.value?.err) throw new Error(`The network rejected transaction ${g + 1} in simulation: ${JSON.stringify(sim.value.err)}. Nothing was sent.`);
      setStatus(`Transaction ${g + 1} of ${groups.length}: waiting for your signature…`, "busy");
      const sig = await signAndSend(connected, tx, async (raw) => rpc<string>("sendTransaction", [Buffer.from(raw).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]));
      log.innerHTML += `<li>Sent <a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">${sig.slice(0, 8)}…</a> (${groups[g].length} action${groups[g].length === 1 ? "" : "s"})</li>`;
    }
    setStatus("Done. Rescanning…", "busy");
    await new Promise((r) => setTimeout(r, 2500));
    await doScan();
  } catch (e: any) {
    setStatus(e?.message || "Something went wrong; nothing more was sent.", "err");
  } finally {
    $("#fixbtn").toggleAttribute("disabled", false);
  }
}

registerMobile();
onWalletsChange(renderWallets);
$("#connectbtn").addEventListener("click", openWalletPicker);
$("#addrform").addEventListener("submit", doScanAddress);
$("#scanbtn").addEventListener("click", doScan);
$("#disconnect").addEventListener("click", doDisconnect);
$("#fixbtn").addEventListener("click", doFix);
$("#fixtoggle").addEventListener("click", () => {
  const list = $("#fixlist");
  list.hidden = !list.hidden;
  $("#fixtoggle").textContent = list.hidden ? `Show what will be sent (${list.children.length})` : "Hide the list";
});
