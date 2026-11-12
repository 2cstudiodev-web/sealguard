// "Share my score": a 1200×630 card (the size X and Telegram preview) drawn in the browser from the report on
// screen. It never shows the wallet address. On phones the system share sheet gets the image; elsewhere the image
// downloads and X opens with the text, so the card can be attached by hand.
const SITE = "https://guard.2cstudio.app";
const SHARE_URL = `${SITE}/?utm_source=share`;

export type ShareInput = { score: number; mine: boolean; reclaimLamports: number };

const solText = (lamports: number) => (lamports / 1e9).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

/** The post text that goes with the card. */
export function shareText(s: ShareInput): string {
  const sol = s.reclaimLamports > 0 ? `, with ${solText(s.reclaimLamports)} SOL to take back from empty accounts` : "";
  return `${s.mine ? "My" : "This"} Solana wallet scored ${s.score}/100 on SealGuard${sol}. Check yours: ${SHARE_URL}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
}

export async function drawCard(s: ShareInput): Promise<Blob> {
  const W = 1200, H = 630, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  await document.fonts?.ready;
  const color = s.score >= 90 ? "#14f195" : s.score >= 60 ? "#f5b544" : "#ff6b6b";

  g.fillStyle = "#050608"; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(300, 330, 40, 300, 330, 420);
  glow.addColorStop(0, "rgba(20,241,149,0.16)"); glow.addColorStop(1, "rgba(20,241,149,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);

  let mark: HTMLImageElement | null = null;
  try { mark = await loadImage("/mark.svg"); g.drawImage(mark, 64, 52, 52, 52); } catch { /* the name alone is enough */ }
  g.fillStyle = "#f4f6f8"; g.font = "800 40px Outfit, system-ui, sans-serif"; g.textBaseline = "middle";
  g.fillText("SealGuard", 130, 80);

  // Score ring
  const cx = 300, cy = 340, r = 150;
  g.lineWidth = 26; g.lineCap = "round";
  g.strokeStyle = "#1c2129"; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = color; g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0.02, s.score / 100))); g.stroke();
  // The shield inside the ring; the score itself is the big number on the right.
  if (mark) g.drawImage(mark, cx - 80, cy - 80, 160, 160);

  // Words
  g.fillStyle = "#9aa3b2"; g.font = "600 36px Inter, system-ui, sans-serif";
  g.fillText(s.mine ? "My Solana wallet scored" : "This Solana wallet scored", 540, 250);
  g.fillStyle = "#f4f6f8"; g.font = "800 112px Outfit, system-ui, sans-serif";
  g.fillText(`${s.score}/100`, 536, 340);
  if (s.reclaimLamports > 0) {
    g.fillStyle = "#14f195"; g.font = "700 36px Inter, system-ui, sans-serif";
    g.fillText(`${solText(s.reclaimLamports)} SOL waiting in empty accounts`, 540, 430, W - 540 - 48);
  }
  g.fillStyle = "#9aa3b2"; g.font = "500 30px Inter, system-ui, sans-serif";
  g.fillText("Free Solana wallet check-up · guard.2cstudio.app", 64, 572);

  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), "image/png"));
}

/** Share sheet with the image where the browser can; otherwise download the image and open X with the text. */
export async function shareScore(s: ShareInput): Promise<void> {
  const text = shareText(s);
  const blob = await drawCard(s);
  const file = new File([blob], "sealguard-score.png", { type: "image/png" });
  const nav: any = navigator;
  if (nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], text }); return; } catch (e: any) { if (e?.name === "AbortError") return; }
  }
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "sealguard-score.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch { /* the post still opens */ }
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}
