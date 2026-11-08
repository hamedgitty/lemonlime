// Turns the SVGs from build.py into the PNG, ICO and ICNS files each app ships, and copies
// the ones the apps serve into place. Run after `python3 brand/build.py`:
//
//   node brand/render.mjs
//
// Uses the sharp that Next.js already installs. The ICNS step needs macOS (iconutil).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const store = join(root, "node_modules/.pnpm");
const sharpDir = readdirSync(store).filter(d => d.startsWith("sharp@")).sort().pop();
if (!sharpDir) throw new Error("sharp isn't installed. Run pnpm install first.");
const sharp = createRequire(join(store, sharpDir, "node_modules/sharp/package.json"))("sharp");

const CREAM = "#FFFBEA";
const src = name => join(here, name);
const out = (...p) => {
  const f = join(...p);
  mkdirSync(dirname(f), { recursive: true });
  return f;
};

/** An SVG drawn at `w`×`h` (fit inside, centred), optionally on a solid background with padding. */
async function png(svg, w, h = w, { bg, pad = 0 } = {}) {
  const inner = await sharp(src(svg), { density: Math.max(72, Math.ceil((72 * Math.max(w, h)) / 400)) })
    .resize({ width: Math.round(w - 2 * pad), height: Math.round(h - 2 * pad), fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: bg ?? { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: inner, gravity: "centre" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** A Windows .ico holding PNG images. */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(i => i.data)]);
}

const write = (file, data) => writeFileSync(out(file), data);
const sized = async (svg, sizes) => Promise.all(sizes.map(async size => ({ size, data: await png(svg, size) })));

// ── The kit itself ──
const kit = join(here, "png");
for (const [svg, w, h] of [
  ["mark.svg", 512], ["mark.svg", 1024], ["mark-ink.svg", 1024], ["mark-cream.svg", 1024],
  ["lockup.svg", 1200, 300], ["lockup-on-dark.svg", 1200, 300], ["lockup-ink.svg", 1200, 300], ["lockup-cream.svg", 1200, 300],
  ["lockup-stacked.svg", 800, 640], ["lockup-stacked-on-dark.svg", 800, 640],
  ["app-icon.svg", 1024],
]) {
  const name = svg.replace(".svg", "") + `-${w}${h && h !== w ? `x${h}` : ""}.png`;
  const meta = await sharp(src(svg)).metadata();
  // Keep the artwork's own proportions: fit inside the box, no padding.
  const ratio = meta.width / meta.height;
  const W = h ? Math.round(Math.min(w, h * ratio)) : w;
  const H = h ? Math.round(W / ratio) : w;
  write(join(kit, name), await png(svg, W, H));
}
write(join(kit, "preview-1200x630.png"), await png("preview.svg", 1200, 630));
write(join(kit, "preview-github-1280x640.png"), await png("preview-github.svg", 1280, 640));

// ── Favicons and home-screen icons ──
const favicon = ico([...(await sized("mark-tiny.svg", [16])), ...(await sized("mark-small.svg", [32, 48]))]);
const apple = await png("mark.svg", 180, 180, { bg: CREAM, pad: 22 });
const icon192 = await png("mark.svg", 192, 192, { bg: CREAM, pad: 30 });
const icon512 = await png("mark.svg", 512, 512, { bg: CREAM, pad: 80 });
write(join(kit, "favicon.ico"), favicon);
write(join(kit, "apple-touch-icon.png"), apple);
write(join(kit, "icon-192.png"), icon192);
write(join(kit, "icon-512.png"), icon512);

// ── Web dashboard (Next.js file conventions) ──
const webApp = join(root, "apps/web/src/app");
copyFileSync(src("mark-small.svg"), out(webApp, "icon.svg"));
write(join(webApp, "favicon.ico"), favicon);
write(join(webApp, "apple-icon.png"), apple);
const preview = readFileSync(join(kit, "preview-1200x630.png"));
write(join(webApp, "opengraph-image.png"), preview);
write(join(webApp, "twitter-image.png"), preview);
write(join(root, "apps/web/public/icon-192.png"), icon192);
write(join(root, "apps/web/public/icon-512.png"), icon512);

// ── Desktop app ──
const icons = join(root, "apps/desktop/src-tauri/icons");
write(join(icons, "32x32.png"), await png("app-icon-square.svg", 32));
write(join(icons, "128x128.png"), await png("app-icon.svg", 128));
write(join(icons, "128x128@2x.png"), await png("app-icon.svg", 256));
write(join(icons, "icon.png"), await png("app-icon.svg", 512));
write(join(icons, "icon.ico"), ico(await sized("app-icon-square.svg", [16, 24, 32, 48, 64, 256])));
if (process.platform === "darwin") {
  const set = join(mkdtempSync(join(tmpdir(), "lemonlime-icon-")), "icon.iconset");
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${s}x${s}.png`), await png("app-icon.svg", s));
    writeFileSync(join(set, `icon_${s}x${s}@2x.png`), await png("app-icon.svg", s * 2));
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(icons, "icon.icns")]);
  rmSync(dirname(set), { recursive: true, force: true });
} else {
  console.log("Skipped icon.icns (needs macOS).");
}
console.log("Brand files written.");
