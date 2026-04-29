import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "..", "build");
const svgPath = resolve(buildDir, "icon.svg");
const pngPath = resolve(buildDir, "icon.png");
const iconsetDir = resolve(buildDir, "icon.iconset");
const icnsPath = resolve(buildDir, "icon.icns");

if (!existsSync(svgPath)) {
  console.error(`missing SVG source: ${svgPath}`);
  process.exit(1);
}

console.log("rasterizing", svgPath, "→", pngPath);
await sharp(svgPath, { density: 384 })
  .resize(1024, 1024, { fit: "contain" })
  .png()
  .toFile(pngPath);

rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

const sizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];
for (const [px, name] of sizes) {
  await sharp(svgPath, { density: 384 })
    .resize(px, px, { fit: "contain" })
    .png()
    .toFile(resolve(iconsetDir, name));
}

console.log("building", icnsPath);
execSync(`iconutil -c icns -o "${icnsPath}" "${iconsetDir}"`, { stdio: "inherit" });

rmSync(iconsetDir, { recursive: true, force: true });
console.log("done");
