// Renders web/public/logo.svg to the PNG sizes the site and stores need. Run: node tools-render-icons.mjs
import sharp from "sharp";
import { readFileSync } from "node:fs";
const svg = readFileSync("web/public/logo.svg");
for (const [name, size] of [["icon.png", 512], ["icon-192.png", 192], ["icon-64.png", 64]]) {
  await sharp(svg, { density: 600 }).resize(size, size).png().toFile(`web/public/${name}`);
}
const mark = readFileSync("web/public/mark.svg");
await sharp(mark, { density: 600 }).resize(400, 400).png().toFile("web/public/mark-400.png");
// favicon.ico and apple-touch-icon.png are made from icon.png with Pillow (sharp has no ICO writer):
//   python -c "from PIL import Image; im=Image.open('web/public/icon.png'); im.save('web/public/favicon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)]); im.resize((180,180)).save('web/public/apple-touch-icon.png')"
console.log("rendered");
