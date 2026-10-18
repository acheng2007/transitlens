import type { MapFrame } from './street-map';
import type { Rect } from './map-panel';

/** Cover crop preserves angles and geography at every output aspect. */
export function drawMapCrop(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, rect: Rect) {
  const width = canvas.width, height = canvas.height;
  const scale = Math.max(rect.w / width, rect.h / height);
  const sw = rect.w / scale, sh = rect.h / scale;
  ctx.drawImage(canvas, (width - sw) / 2, (height - sh) / 2, sw, sh, rect.x, rect.y, rect.w, rect.h);
}

/** Both layers retain the parent's animation opacity. */
export function drawFloatingMapLayers(ctx: CanvasRenderingContext2D, frame: MapFrame, rect: Rect) {
  ctx.save();
  ctx.globalAlpha *= 0.30;
  drawMapCrop(ctx, frame.baseCanvas, rect);
  ctx.restore();
  if (frame.located) drawMapCrop(ctx, frame.overlayCanvas, rect);
}
