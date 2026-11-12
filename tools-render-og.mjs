// Renders web/public/og.png (1200×630 share image) from the icon and the home page headline.
//   node tools-render-og.mjs [out.png]
import sharp from "sharp";

const out = process.argv[2] ?? "web/public/og.png";
const W = 1200, H = 630;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const font = "Segoe UI, Arial, sans-serif";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#050608"/>
  <circle cx="1080" cy="80" r="260" fill="#14f195" opacity="0.06"/>
  <text x="200" y="118" font-family="${font}" font-weight="700" font-size="40" fill="#f4f6f8">SealGuard</text>
  <text x="200" y="158" font-family="${font}" font-size="26" fill="#9aa3b2">guard.2cstudio.app</text>
  <text x="80" y="290" font-family="${font}" font-weight="800" font-size="76" fill="#f4f6f8">${esc("Got SOL hiding in your wallet?")}</text>
  <rect x="72" y="320" width="792" height="100" rx="14" fill="#14f195"/>
  <text x="92" y="396" font-family="${font}" font-weight="800" font-size="76" fill="#04140c">${esc("Find it in 30 seconds.")}</text>
  <text x="80" y="490" font-family="${font}" font-size="30" fill="#9aa3b2">${esc("Empty token accounts and pump.fun deposits hold SOL you can take back.")}</text>
  <text x="80" y="534" font-family="${font}" font-size="30" fill="#9aa3b2">${esc("Free scan. Every fix is signed in your own wallet. Open source.")}</text>
</svg>`;

const icon = await sharp("web/public/icon.png").resize(96, 96).toBuffer();
await sharp(Buffer.from(svg)).composite([{ input: icon, left: 80, top: 72 }]).png().toFile(out);
console.log("wrote", out);
