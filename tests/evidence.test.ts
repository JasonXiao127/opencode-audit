import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FINDINGS_PER_CALL,
  MAX_OUTPUT_CHARS,
  parseFindings,
  checkEvidence,
  quoteHash,
  repetitionScore,
} from "../src/core/evidence.js";

function finding(o: Record<string, unknown> = {}): string {
  return JSON.stringify({
    file: "src/a.ts",
    line: 10,
    category: "correctness",
    severity: "high",
    title: "off by one",
    claim: "loop reads past the end",
    mechanism: "i <= n indexes arr[n]",
    trigger: "call f with n = arr.length",
    quote: "for (let i = 0; i <= n; i++)",
    disproof: "n is clamped before the loop",
    confidence: 0.6,
    ...o,
  });
}

test("constants", () => {
  assert.equal(MAX_FINDINGS_PER_CALL, 12);
  assert.equal(MAX_OUTPUT_CHARS, 24000);
});

test("parse accepts a bare array and defaults alternatives/nextReads", () => {
  const r = parseFindings(`[ ${finding()} ]`);
  assert.equal(r.jsonInvalid, false);
  assert.equal(r.rawTruncated, false);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].alternatives, []);
  assert.deepEqual(r.findings[0].nextReads, []);
  assert.equal(r.skipped.length, 0);
});

test("parse tolerates a findings wrapper and fenced blocks", () => {
  const r = parseFindings('```json\n{"findings": [' + finding() + "]}\n```");
  assert.equal(r.jsonInvalid, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].file, "src/a.ts");
});

test("parse rejects missing claim/trigger/disproof with reasons", () => {
  const { title: _t, ...noTitle } = JSON.parse(finding());
  void _t;
  void noTitle;
  const bad = [
    { ...JSON.parse(finding()), claim: "  " },
    { ...JSON.parse(finding()), trigger: "" },
    { ...JSON.parse(finding()), disproof: undefined },
  ];
  const r = parseFindings(JSON.stringify(bad));
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["no-claim", "no-trigger", "no-disproof"]);
});

test("parse slices long fields and flags truncation", () => {
  const r = parseFindings(
    JSON.stringify([
      {
        ...JSON.parse(finding()),
        title: "t".repeat(500),
        claim: "c".repeat(900),
        mechanism: "m".repeat(3000),
        trigger: "g".repeat(3000),
        quote: "q".repeat(5000),
      },
    ]),
  );
  assert.equal(r.findings[0].title.length, 200);
  assert.equal(r.findings[0].claim.length, 500);
  assert.equal(r.findings[0].mechanism.length, 1000);
  assert.equal(r.findings[0].trigger.length, 1000);
  assert.equal(r.findings[0].quote.length, 2000);

  const padded = `[${finding()}]` + " ".repeat(MAX_OUTPUT_CHARS + 10);
  const rt = parseFindings(padded);
  assert.equal(rt.rawTruncated, true);
  assert.equal(rt.findings.length, 1);
});

test("parse caps at 12 and marks the rest over-cap; garbage is jsonInvalid", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ ...JSON.parse(finding()), line: i + 1 }));
  const r = parseFindings(JSON.stringify(many));
  assert.equal(r.findings.length, 12);
  assert.equal(r.skipped.filter((s) => s.reason === "over-cap").length, 3);

  const g = parseFindings("no json here, just prose about bugs");
  assert.equal(g.jsonInvalid, true);
  assert.equal(g.findings.length, 0);
});

test("evidence gate accepts a good quote", () => {
  const fileLines = ["export function f(n: number) {", "  let s = 0;", "  for (let i = 0; i <= n; i++) {", "    s += i;", "  }", "}"];
  const r = checkEvidence({ line: 3, quote: "for (let i = 0; i <= n; i++) {" }, fileLines);
  assert.deepEqual(r, { ok: true, reason: "ok" });
});

test("evidence gate accepts quotes with N| prefixes (normalizes)", () => {
  const fileLines = ["a", "  for (let i = 0; i <= n; i++) {", "b"];
  const r = checkEvidence({ line: 2, quote: "2|   for (let i = 0; i <= n; i++) {" }, fileLines);
  assert.equal(r.ok, true);
});

test("evidence gate rejects hallucinated quotes and out-of-range lines", () => {
  const fileLines = ["const a = 1;", "const b = 2;"];
  const hall = checkEvidence({ line: 1, quote: "rm -rf / --no-preserve-root" }, fileLines);
  assert.equal(hall.ok, false);
  assert.equal(hall.reason, "quote-not-found");
  const oor = checkEvidence({ line: 99, quote: "const a = 1;" }, fileLines);
  assert.equal(oor.ok, false);
  assert.equal(oor.reason, "line-out-of-range");
  const empty = checkEvidence({ line: 1, quote: "   \n  " }, fileLines);
  assert.equal(empty.ok, false);
});

test("quoteHash is stable, normalized, and file-scoped", () => {
  const a = quoteHash("src/a.ts", "3|  for (let i = 0; i <= n; i++) {");
  const b = quoteHash("src/a.ts", "for (let i = 0;  i <= n; i++) {");
  const c = quoteHash("src/b.ts", "for (let i = 0; i <= n; i++) {");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]+$/);
});

test("repetitionScore flags loops, passes normal text", () => {
  const looped = "ERROR: connection timed out\n".repeat(40);
  const hi = repetitionScore(looped);
  assert.ok(hi.score > 0.7, `expected high score, got ${hi.score}`);
  assert.ok(hi.reasons.length > 0);

  const normal = [
    "export function add(a: number, b: number) {",
    "  const sum = a + b;",
    "  if (sum > 100) throw new Error('too big');",
    "  return sum;",
    "}",
    "export const PI = 3.14159;",
    "const names = ['ada', 'grace', 'katherine'];",
    "for (const n of names) console.log(n);",
  ].join("\n");
  const lo = repetitionScore(normal);
  assert.ok(lo.score < 0.4, `expected low score, got ${lo.score}`);

  assert.deepEqual(repetitionScore("a\nb"), { score: 0, reasons: [] });
});
