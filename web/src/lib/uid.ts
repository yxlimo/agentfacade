/**
 * Generate an identifier that works in every browsing context.
 *
 * `crypto.randomUUID` only exists in secure contexts (HTTPS or localhost).
 * The panel must also open over plain HTTP on a LAN address such as
 * `http://192.168.x.x`, where browsers leave `randomUUID` undefined and a
 * direct call crashes the whole page. Fall back, in order:
 *
 * 1. `crypto.randomUUID` when available;
 * 2. `crypto.getRandomValues` (available in every context) to fill a
 *    v4-shaped UUID;
 * 3. a timestamp + counter, so ids stay unique within one session even
 *    without any crypto API. This branch never throws.
 */
let counter = 0
let lastMs = ''

export function newUid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    // Set version 4 and variant bits so the result is a well-formed UUID.
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  }
  // Last resort: timestamp plus a counter, unique within this session.
  const now = `${Date.now()}`
  counter = now === lastMs ? counter + 1 : 0
  lastMs = now
  return `uid-${now}-${counter}`
}
