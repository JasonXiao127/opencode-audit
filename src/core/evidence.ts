// Evidence gate + finder-output parsing. Pure logic, no I/O.
// Node builtins only (node:crypto, node:zlib); no runtime dependencies.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { FindingInput, NextRead, ReplicatorOutput, ReplicatorVerdict } from "./types.js";

/** Flood control: at most this many findings are kept per finder call. */
export const MAX_FINDINGS_PER_CALL = 12;

/** Outputs longer than this are truncated before parsing. */
export const MAX_OUTPUT_CHARS = 24000;

export interface SkippedFinding {
  title: string;
  line: number;
  reason: string;
}

export interface ParseFindingsResult {
  findings: FindingInput[];
  /** True when no usable findings JSON could be extracted. */
  jsonInvalid: boolean;
  /** True when the raw text exceeded MAX_OUTPUT_CHARS and was cut. */
  rawTruncated: boolean;
  skipped: SkippedFinding[];
}

export interface EvidenceCheck {
  ok: boolean;
  reason: string;
}

export interface RepetitionResult {
  score: number;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/** Scan `s` from `start` for the matching close bracket, string-aware. */
function matchEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** First balanced {...} or [...] value in `s` that JSON.parses, else null. */
function scanFirst(s: string): { found: boolean; value?: unknown } {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = matchEnd(s, i);
    if (end === -1) continue;
    try {
      return { found: true, value: JSON.parse(s.slice(i, end + 1)) };
    } catch {
      // Not valid JSON at this start; keep scanning.
    }
  }
  return { found: false };
}

/** Extract the first JSON object/array, preferring fenced code blocks. */
function extractJson(text: string): { found: boolean; value?: unknown } {
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) candidates.push(m[1]);
  candidates.push(text);
  for (const c of candidates) {
    const r = scanFirst(c);
    if (r.found) return r;
  }
  return { found: false };
}

// ---------------------------------------------------------------------------
// Field coercion
// ---------------------------------------------------------------------------

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (typeof e === "string" && e.trim().length > 0) out.push(e);
  }
  return out;
}

function toNextReads(v: unknown): NextRead[] {
  if (!Array.isArray(v)) return [];
  const out: NextRead[] = [];
  for (const e of v) {
    if (typeof e === "string" && e.trim().length > 0) {
      const s = e.trim();
      const dash = s.match(/^(.*?)\s+[—–-]\s+(.*)$/);
      if (dash) out.push({ loc: dash[1].trim(), why: dash[2].trim() });
      else out.push({ loc: s, why: "" });
    } else if (e !== null && typeof e === "object") {
      const o = e as Record<string, unknown>;
      if (typeof o["loc"] === "string" && (o["loc"] as string).trim().length > 0) {
        out.push({ loc: (o["loc"] as string).trim(), why: asString(o["why"]) });
      }
    }
  }
  return out;
}

const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// parseFindings
// ---------------------------------------------------------------------------

/**
 * Leniently parse finder output. Requires claim+trigger+disproof per finding;
 * missing ones land in `skipped` with reasons no-claim/no-trigger/no-disproof.
 * Missing alternatives/nextReads default to []. Long text fields are sliced.
 */
export function parseFindings(text: string): ParseFindingsResult {
  const skipped: SkippedFinding[] = [];
  const rawTruncated = text.length > MAX_OUTPUT_CHARS;
  const cut = rawTruncated ? text.slice(0, MAX_OUTPUT_CHARS) : text;

  const extracted = extractJson(cut);
  if (!extracted.found) {
    return { findings: [], jsonInvalid: true, rawTruncated, skipped };
  }
  const v = extracted.value;
  let items: unknown[];
  if (Array.isArray(v)) {
    items = v;
  } else if (v !== null && typeof v === "object" && Array.isArray((v as Record<string, unknown>)["findings"])) {
    items = (v as Record<string, unknown>)["findings"] as unknown[];
  } else if (v !== null && typeof v === "object" && typeof (v as Record<string, unknown>)["file"] !== "undefined") {
    items = [v];
  } else {
    return { findings: [], jsonInvalid: true, rawTruncated, skipped };
  }

  const findings: FindingInput[] = [];
  const capped = items.slice(0, MAX_FINDINGS_PER_CALL);
  const overflow = items.slice(MAX_FINDINGS_PER_CALL);
  for (const o of overflow) {
    const r = o as Record<string, unknown>;
    skipped.push({
      title: typeof r?.["title"] === "string" ? (r["title"] as string).slice(0, 200) : "",
      line: typeof r?.["line"] === "number" ? (r["line"] as number) : 0,
      reason: "over-cap",
    });
  }

  for (const item of capped) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      skipped.push({ title: "", line: 0, reason: "not-object" });
      continue;
    }
    const o = item as Record<string, unknown>;
    const title = asString(o["title"]).slice(0, 200);
    const line = typeof o["line"] === "number" ? o["line"] : Number(o["line"]);
    const loc = { title, line: Number.isInteger(line) ? (line as number) : 0 };
    if (!nonEmpty(o["claim"])) {
      skipped.push({ ...loc, reason: "no-claim" });
      continue;
    }
    if (!nonEmpty(o["trigger"])) {
      skipped.push({ ...loc, reason: "no-trigger" });
      continue;
    }
    if (!nonEmpty(o["disproof"])) {
      skipped.push({ ...loc, reason: "no-disproof" });
      continue;
    }
    if (!nonEmpty(o["file"])) {
      skipped.push({ ...loc, reason: "bad-file" });
      continue;
    }
    if (!Number.isInteger(line) || (line as number) < 1) {
      skipped.push({ ...loc, reason: "bad-line" });
      continue;
    }
    const sev = asString(o["severity"]).toLowerCase();
    const endLineRaw = o["endLine"];
    const endLine =
      typeof endLineRaw === "number" && Number.isInteger(endLineRaw) && endLineRaw >= (line as number)
        ? endLineRaw
        : undefined;
    findings.push({
      file: (o["file"] as string).trim(),
      line: line as number,
      ...(endLine !== undefined ? { endLine } : {}),
      category: nonEmpty(o["category"]) ? (o["category"] as string).trim() : "correctness",
      severity: (SEVERITIES.has(sev) ? sev : "medium") as FindingInput["severity"],
      title,
      claim: (o["claim"] as string).slice(0, 500),
      mechanism: asString(o["mechanism"]).slice(0, 1000),
      trigger: (o["trigger"] as string).slice(0, 1000),
      quote: asString(o["quote"]).slice(0, 2000),
      scope: asString(o["scope"]) || undefined,
      alternatives: toStringArray(o["alternatives"]),
      disproof: o["disproof"] as string,
      confidence: asConfidence(o["confidence"]),
      nextReads: toNextReads(o["nextReads"]),
    });
  }

  return { findings, jsonInvalid: false, rawTruncated, skipped };
}

// ---------------------------------------------------------------------------
// Evidence gate
// ---------------------------------------------------------------------------

/** Normalize one line: strip `N|`/`N:` prefixes, collapse space, lowercase. */
function normalizeLine(s: string): string {
  return s
    .replace(/^\s*\d+\s*[|:]\s?/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Every non-empty quote line must appear in order within ±window lines
 * of the cited (1-based) line. Normalizes whitespace/case and strips
 * `N|` line-number prefixes on both sides.
 */
export function checkEvidence(
  finding: Pick<FindingInput, "line" | "quote">,
  fileLines: string[],
  window = 8,
): EvidenceCheck {
  const line = finding.line;
  if (!Number.isInteger(line) || line < 1 || line > fileLines.length) {
    return { ok: false, reason: "line-out-of-range" };
  }
  const qlines = finding.quote
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l.length > 0);
  if (qlines.length === 0) {
    return { ok: false, reason: "empty-quote" };
  }
  const lo = Math.max(0, line - 1 - window);
  const hi = Math.min(fileLines.length, line + window);
  const win = fileLines.slice(lo, hi).map(normalizeLine);
  let idx = 0;
  for (const q of qlines) {
    let found = -1;
    for (let i = idx; i < win.length; i++) {
      if (win[i].length === 0) continue;
      if (win[i] === q || win[i].includes(q) || (win[i].length >= 10 && q.includes(win[i]))) {
        found = i;
        break;
      }
    }
    if (found === -1) return { ok: false, reason: "quote-not-found" };
    idx = found + 1;
  }
  return { ok: true, reason: "ok" };
}

/** Stable content id: sha256 of `file + normalized quote`, first 16 hex chars. */
export function quoteHash(file: string, quote: string): string {
  const norm = quote
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l.length > 0)
    .join("\n");
  return createHash("sha256").update(`${file}\n${norm}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Repetition / loop detector
// ---------------------------------------------------------------------------

/**
 * Score pasted model output for degenerate looping (0..1) with reasons.
 * Three cheap signals: repeated adjacent-line shingles, duplicate-line
 * ratio, and deflate compressibility.
 */
export function repetitionScore(text: string): RepetitionResult {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 4) return { score: 0, reasons: [] };

  const total = lines.length;
  const uniq = new Set(lines).size;
  const lineDup = 1 - uniq / total;

  const bigrams: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) bigrams.push(lines[i] + "\n" + lines[i + 1]);
  const bigramRep = 1 - new Set(bigrams).size / bigrams.length;

  let comp = 0;
  const raw = Buffer.byteLength(text, "utf8");
  if (raw > 0) {
    try {
      const ratio = deflateSync(text).length / raw;
      comp = Math.min(1, Math.max(0, (0.55 - ratio) / 0.45));
    } catch {
      comp = 0;
    }
  }

  const score = Math.round(Math.min(1, Math.max(0, 0.4 * bigramRep + 0.3 * lineDup + 0.3 * comp)) * 100) / 100;
  const reasons: string[] = [];
  if (bigramRep > 0.3) {
    reasons.push(`repeated adjacent-line blocks (${Math.round(bigramRep * 100)}% of line pairs repeat)`);
  }
  if (lineDup > 0.3) {
    reasons.push(`${total - uniq} of ${total} lines duplicated`);
  }
  if (comp > 0.5) {
    reasons.push("highly compressible output (deflate ratio suggests looping)");
  }
  return { score, reasons };
}

export interface ParseReplicatorResult {
  output: ReplicatorOutput | null;
  jsonInvalid: boolean;
}

function asStringArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push(x.slice(0, 500));
    if (out.length >= cap) break;
  }
  return out;
}

function asNextReads(v: unknown): NextRead[] {
  const out: NextRead[] = [];
  const push = (loc: string, why: string): void => {
    if (loc.trim()) out.push({ loc: loc.slice(0, 200), why: why.slice(0, 300) });
  };
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === "string") {
        const i = x.indexOf("—");
        push(i >= 0 ? x.slice(0, i).trim() : x.trim(), i >= 0 ? x.slice(i + 1).trim() : "");
      } else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (typeof o["loc"] === "string") push(o["loc"], typeof o["why"] === "string" ? o["why"] : "");
      }
      if (out.length >= 4) break;
    }
  }
  return out;
}

/**
 * Parse a falsifier (replicator) response. Lenient on optional fields,
 * strict on the verdict: an unknown or missing verdict is jsonInvalid and
 * the lead keeps its single-read basis (never upgraded on garbage).
 */
export function parseReplicator(text: string): ParseReplicatorResult {
  const start = text.search(/[{[]/);
  if (start < 0) return { output: null, jsonInvalid: true };
  const candidate = text.slice(start);
  const attempts: string[] = [candidate];
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (end > 0 && end < candidate.length - 1) attempts.push(candidate.slice(0, end + 1));
  for (const a of attempts) {
    try {
      const parsed = JSON.parse(a) as Record<string, unknown>;
      const v = parsed["verdict"];
      const verdict: ReplicatorVerdict | null =
        v === "reproduced" || v === "plausible-unverified" || v === "rejected" ? v : null;
      if (!verdict) continue;
      const num = (x: unknown, dflt: number): number =>
        typeof x === "number" && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : dflt;
      return {
        output: {
          verdict,
          reason: String(parsed["reason"] ?? "").slice(0, 500),
          recipe: asStringArray(parsed["recipe"], 8),
          expectedVsActual: String(parsed["expectedVsActual"] ?? "").slice(0, 1000),
          alternatives: asStringArray(parsed["alternatives"], 4),
          disproofCheck: String(parsed["disproofCheck"] ?? "").slice(0, 500),
          unverified: asStringArray(parsed["unverified"], 6),
          nextReads: asNextReads(parsed["nextReads"]),
          confidence: num(parsed["confidence"], 0.5),
        },
        jsonInvalid: false,
      };
    } catch {
      continue;
    }
  }
  return { output: null, jsonInvalid: true };
}
