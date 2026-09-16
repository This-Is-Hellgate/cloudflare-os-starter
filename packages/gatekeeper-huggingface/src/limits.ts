// Pure output/budget helpers shared by the Hugging Face gatekeeper's bounded read paths.
//
// Declared ceilings are UTF-8 BYTES. JSON.stringify(...).length counts UTF-16 code units: a
// string of emoji or CJK counts ~1-2 units per character but encodes to 2-4 bytes, so a
// unit-counted "256 KB" output can actually be ~1 MB. Every budget in this module accounts
// bytes with TextEncoder so the declared ceiling holds for any content.
//
// Free of `cloudflare:workers` imports so the fixtures drive the real helpers.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 byte length of a string. The one measure every declared ceiling uses. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Strips a torn trailing multi-byte character so decoding never emits a partial sequence.
 * The last lead byte within the final four bytes decides: if its announced sequence fits in
 * the remaining bytes the tail is complete and nothing is stripped; otherwise the partial
 * sequence (lead plus any continuations) is removed.
 */
function trimTornTail(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return bytes;
  let leadIndex = -1;
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i -= 1) {
    if ((bytes[i] & 0xC0) !== 0x80) { leadIndex = i; break; }
  }
  // A valid UTF-8 sequence has at most three continuations, so four means complete.
  if (leadIndex === -1) return bytes;
  const lead = bytes[leadIndex];
  let announced = 1;
  if ((lead & 0xE0) === 0xC0) announced = 2;
  else if ((lead & 0xF0) === 0xE0) announced = 3;
  else if ((lead & 0xF8) === 0xF0) announced = 4;
  const needed = leadIndex + announced;
  // Complete when the announced sequence fits; otherwise the whole partial sequence goes.
  return needed <= bytes.length ? bytes : bytes.subarray(0, leadIndex);
}

/**
 * Caps a serialized value at a UTF-8 byte ceiling: within the bound the value is returned
 * as-is; beyond it the encoded text is cut at the ceiling (whole characters preserved) with a
 * trailing ellipsis marker and `truncated: true`.
 */
export function capOutput(value: unknown, maxBytes = 256_000): { output: unknown; truncated: boolean } {
  const text = JSON.stringify(value) ?? "null";
  if (utf8Bytes(text) <= maxBytes) return { output: value, truncated: false };
  // The truncation marker lives WITHIN the ceiling: the delivered output never exceeds the bound.
  const marker = "\u2026";
  const room = Math.max(0, maxBytes - utf8Bytes(marker));
  const capped = trimTornTail(encoder.encode(text).slice(0, room));
  return { output: decoder.decode(capped) + "\u2026", truncated: true };
}

/**
 * Keeps whole rows within a cumulative UTF-8 byte budget: rows are encoded once (no repeated
 * stringify), the walk stops before the ceiling is crossed, and at least one row is always
 * kept — a single oversized row is delivered alone rather than silently vanishing.
 */
export function fitRowsToByteBudget(rows: unknown[][], maxBytes: number): { kept: unknown[][]; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const rowBytes = utf8Bytes(JSON.stringify(rows[i])) + (i > 0 ? 1 : 0);
    if (i > 0 && bytes + rowBytes > maxBytes) break;
    bytes += rowBytes;
    end = i + 1;
  }
  return { kept: rows.slice(0, Math.max(end, 1)), truncated: end < rows.length };
}

/**
 * Streams a text response with a HARD byte ceiling: reading stops (the stream is cancelled)
 * once the cap is crossed, so an oversized body is never fully buffered. Torn multi-byte
 * remnants are stripped before decoding. A body-less response falls back to a conservative
 * quarter-of-cap text read.
 */
export async function streamTextCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.slice(0, Math.ceil(maxBytes / 4));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const capped = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, capped.length - offset);
    capped.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= capped.length) break;
  }
  return decoder.decode(trimTornTail(capped));
}
