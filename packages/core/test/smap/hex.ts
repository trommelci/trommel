// Test helpers: bytes as spaced hex, the way the specification writes them.

/** `'80 01'` → bytes; spaces are for the reader. */
export function bytesOf(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replaceAll(/\s+/g, ''), 'hex'));
}

export function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/** The UTF-8 bytes of ASCII text, as spaced hex. */
export function ascii(text: string): string {
  return hexOf(new TextEncoder().encode(text));
}
