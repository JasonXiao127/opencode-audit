// Line-based file chunker with overlap, plus drift-detection hashes.
// Only Node builtins.

import { createHash } from "node:crypto";
import type { Chunk } from "./types.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** sha256 of `file + raw (unnumbered) body`. */
export function hashChunk(file: string, body: string): string {
  return sha256Hex(file + body);
}

/**
 * Drift-detection hash for a 1-based line: sha256 of the whitespace-
 * normalized lines ±10 around it. Edits outside the window leave it stable.
 */
export function findingContext(lines: string[], line: number): string {
  const hi = Math.max(lines.length, 1);
  const idx = Math.min(Math.max(Math.trunc(line) || 1, 1), hi) - 1;
  const start = Math.max(0, idx - 10);
  const end = Math.min(lines.length, idx + 11);
  const window = lines.slice(start, end).map((l) => l.replace(/\r/g, "").trim());
  return sha256Hex(window.join("\n"));
}

/**
 * Split content by lines into pieces whose numbered body is ≤ maxChars.
 * Consecutive chunks share `overlapLines` lines; every chunk carries the
 * first `headerLines` raw lines as `header`. Body lines are numbered
 * `N| text` with 1-based N. `hash` covers the raw body; `contextHash` is the
 * `findingContext` of the chunk's middle line.
 */
export function chunkFile(
  file: string,
  content: string,
  maxChars = 40000,
  overlapLines = 40,
  headerLines = 30,
): Chunk[] {
  const lines = content.split("\n");
  const n = lines.length;
  const header = lines.slice(0, Math.max(0, headerLines)).join("\n");
  const numbered = (i: number): string => `${i + 1}| ${lines[i]}`;
  const overlap = Math.max(0, Math.trunc(overlapLines) || 0);

  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < n) {
    let len = numbered(start).length;
    let end = start;
    while (end + 1 < n && len + 1 + numbered(end + 1).length <= maxChars) {
      end += 1;
      len += 1 + numbered(end).length;
    }
    ranges.push([start, end]);
    if (end >= n - 1) break;
    const next = end - overlap + 1;
    start = next > start ? next : end + 1;
  }

  const totalChunks = ranges.length;
  return ranges.map(([s, e], i) => {
    const text = Array.from({ length: e - s + 1 }, (_, k) => numbered(s + k)).join("\n");
    const rawBody = lines.slice(s, e + 1).join("\n");
    const midLine = Math.floor((s + 1 + (e + 1)) / 2);
    return {
      file,
      chunkIndex: i,
      totalChunks,
      startLine: s + 1,
      endLine: e + 1,
      header,
      text,
      hash: hashChunk(file, rawBody),
      contextHash: findingContext(lines, midLine),
    } satisfies Chunk;
  });
}
