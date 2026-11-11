// Renders web/public/logo.svg to the PNG sizes the site and stores need. Run: node tools-render-icons.mjs
import sharp from "sharp";
import { readFileSync } from "node:fs";
const svg = readFileSync("web/public/logo.svg");
for (const [name, size] of [["icon.png", 512], ["icon-192.png", 192], ["icon-64.png", 64]]) {
  await sharp(svg, { density: 600 }).resize(size, size).png().toFile(`web/public/${name}`);
}
const mark = readFileSync("web/public/mark.svg");
await sharp(mark, { density: 600 }).resize(400, 400).png().toFile("web/public/mark-400.png");
console.log("rendered");
