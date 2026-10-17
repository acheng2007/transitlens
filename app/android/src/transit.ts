/** Native builds use a configured public transit server; desktop development uses Vite's proxy. */
export function nativeTransitEndpoint(baseUrl: string | undefined, native: boolean): string | null {
  if (!baseUrl?.trim()) return native ? null : '/api/buses/nearby';
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' && (native || base.protocol !== 'http:')) return null;
    return new URL('/api/buses/nearby', base).href;
  } catch { return null; }
}
