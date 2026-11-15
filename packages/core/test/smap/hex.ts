// Test helpers: bytes as spaced hex, the way the specification writes them.
import { createHash } from 'node:crypto';


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

export type HandSection = readonly [tag: string, layer: number, flags: number, version: number, body: string];

const le = (value: number, bytes: number): string => hexOf(Uint8Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** i) % 256));

/**
 * A SMAP file put together by hand from hex: `header` is everything before the section table, and
 * each section gives its table fields and its body. No code under test is involved; only the
 * offsets, the lengths and the SHA-256 trailer are computed here.
 */
export function assemble(header: string, sections: readonly HandSection[]): { bytes: Uint8Array; offsets: number[] } {
  const bodies = sections.map(([, , , , body]) => bytesOf(body));
  let offset = bytesOf(header).length + sections.length * 16;
  const offsets: number[] = [];
  const table = sections.map(([tag, layer, flags, version], i) => {
    offsets.push(offset);
    const entry = `${ascii(tag)} ${le(layer, 1)} ${le(flags, 1)} ${le(version, 2)} ${le(offset, 4)} ${le(bodies[i]!.length, 4)}`;
    offset += bodies[i]!.length;
    return entry;
  });
  const content = bytesOf([header, ...table, ...bodies.map(hexOf)].join(' '));
  const bytes = new Uint8Array(content.length + 32);
  bytes.set(content);
  bytes.set(createHash('sha256').update(content).digest(), content.length);
  return { bytes, offsets };
}
