import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;

import { PublicKey } from "@solana/web3.js";
import { fetchScanInput, rpc } from "./rpc";
import { scan, shortKey, type Action, type Finding, type ScanResult, type Severity } from "./scan";
import { batchActions, buildTransaction, describeAction } from "./tx";
import { connect, disconnect, listWallets, onWalletsChange, registerMobile, signAndSend, type Connected } from "./wallet";

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
  if (!ws.length) {
    box.innerHTML = `<p class="muted">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, or open this page inside your wallet app's browser. On a Seeker, open it in any browser and pick Seed Vault.</p>`;
    return;
  }
  box.innerHTML = ws.map((w, i) => `<button class="wbtn" data-i="${i}"><img src="${esc(w.icon)}" alt="" width="22" height="22"> ${esc(w.name)}</button>`).join("");
  box.querySelectorAll<HTMLButtonElement>(".wbtn").forEach((b) => b.addEventListener("click", () => doConnect(ws[Number(b.dataset.i)])));
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
  showSession();
  setStatus("");
  void doScan();
}

async function doDisconnect(): Promise<void> {
  if (connected) await disconnect(connected);
  connected = null; address = null; result = null; selected = new Set();
  $("#session").hidden = true;
  $("#report").hidden = true;
  $("#connect").hidden = false;
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
  $("#checked").textContent = `Looked at ${r.checked.tokenAccounts} token accounts, ${r.checked.mints} Token-2022 mints, ${r.checked.stakes} stake accounts and ${r.checked.nonces} nonce accounts.` + (r.warnings.length ? ` ${r.warnings.join(" ")}` : "");

  const list = $("#findings");
  list.innerHTML = r.findings.map((f, i) => card(f, i)).join("");
  list.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
    const i = Number(cb.dataset.i);
    if (cb.checked) selected.add(i); else selected.delete(i);
    renderFixBar();
  }));
  renderFixBar();
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
  $("#fixlist").innerHTML = acts.map((a) => `<li>${esc(describeAction(a))}</li>`).join("");
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
renderWallets();
onWalletsChange(renderWallets);
$("#addrform").addEventListener("submit", doScanAddress);
$("#scanbtn").addEventListener("click", doScan);
$("#disconnect").addEventListener("click", doDisconnect);
$("#fixbtn").addEventListener("click", doFix);
