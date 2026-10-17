// Builds the app icon sources in assets/generated/ from assets/logo.png, then @capacitor/assets turns
// them into every Android density (npm run assets). To change the logo, replace the file and re-run.
//
// logo.png sits on an opaque BG (#0b0d10) with detail (corner brackets) out near its edges, so the
// adaptive icon shrinks it to fit inside the circle launchers crop to, on a matching background.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DIR = fileURLToPath(new URL('../assets/', import.meta.url));
// Generated sources go in their own folder: @capacitor/assets would otherwise also run its own
// single-logo mode on assets/logo.png and overwrite the adaptive icon made here.
const OUT = `${DIR}generated/`;
const LOGO = `${DIR}logo.png`;
/** logo.png's background: fills the icon around the shrunk logo so its edges don't show. */
export const BG = '#0b0d10';

/**
 * Adaptive icon: ic_launcher.xml insets both layers 16.7% per side, i.e. onto the visible 72 of the
 * 108 dp layer, so the foreground canvas IS the visible icon and a circle launcher keeps a circle as
 * wide as it. Android only guarantees the middle 91.7% of that circle (the 66 dp safe zone), so the
 * logo is scaled until its farthest non-background pixel lands at this fraction of the radius.
 */
const CONTENT_RADIUS = 0.9;

/** Farthest pixel that isn't background, as a fraction of the logo's width, from its center. */
async function contentRadius() {
  const { data, info } = await sharp(LOGO).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [br, bg, bb] = [0x0b, 0x0d, 0x10];
  let max = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 60) {
        max = Math.max(max, Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2));
      }
    }
  }
  return max / info.width;
}

/** A size x size PNG: `bg` filled, with the logo (squared) centered at `scale` of the canvas. */
async function canvas(size, scale, bg) {
  const base = sharp({ create: { width: size, height: size, channels: 4, background: bg } });
  if (!scale) return base.png();
  const px = Math.round(size * scale);
  const logo = await sharp(LOGO).resize(px, px, { fit: 'cover', kernel: 'lanczos3' }).png().toBuffer();
  const offset = Math.round((size - px) / 2);
  return base.composite([{ input: logo, left: offset, top: offset }]).png();
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const foregroundScale = (CONTENT_RADIUS * 0.5) / (await contentRadius());
console.log(`adaptive icon: logo at ${Math.round(foregroundScale * 100)}% of the icon`);

const files = {
  // Legacy (pre-Android 8) square icon: the logo edge to edge.
  'icon-only.png': () => canvas(1024, 1, BG),
  'icon-foreground.png': () => canvas(1024, Math.min(1, foregroundScale), TRANSPARENT),
  'icon-background.png': () => canvas(1024, 0, BG),
};

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(files)) {
  await (await make()).toFile(`${OUT}${name}`);
  console.log(`assets/generated/${name}`);
}
