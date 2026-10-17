// "Open on your phone" panel for the start screen when it's viewed on a laptop.
// The phone needs HTTPS (camera, GPS, compass), so the link is either this page itself when it's
// already served over a tunnel, or the tunnel URL that `npm run phone` shares via /api/phone-url.

import QRCode from 'qrcode';

const isLocalHost = (host: string) => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);

/** Touch phones/tablets don't need the panel: they're already the device that runs the app. */
const isPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches);

async function phoneUrl(): Promise<string | null> {
  if (location.protocol === 'https:' && !isLocalHost(location.hostname)) return location.origin + location.pathname;
  try {
    const res = await fetch('/api/phone-url', { cache: 'no-store' });
    if (!res.ok) return null;
    const { url } = (await res.json()) as { url?: string };
    return url?.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
}

/** Fills #phone-link with a QR code + URL, or a hint to run `npm run phone`. Hidden on phones. */
export async function showPhoneLink() {
  const panel = document.getElementById('phone-link');
  if (!panel || isPhone()) return;
  const url = await phoneUrl();
  const qr = panel.querySelector<HTMLElement>('.qr')!;
  const text = panel.querySelector<HTMLElement>('.phone-url')!;
  if (url) {
    qr.innerHTML = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0b1020', light: '#f8fafc' } });
    text.textContent = url.replace(/^https:\/\//, '').replace(/\/$/, '');
    panel.dataset.state = 'ready';
  } else {
    panel.dataset.state = 'missing';
  }
  panel.hidden = false;
}
