import { test } from "node:test";
import assert from "node:assert/strict";
import { BASIS_ORDER, rankScore, sortFindings, sectionFor, deriveCheckCost } from "../src/core/ranking.js";
import type { FindingBasis } from "../src/core/types.js";

test("BASIS_ORDER ranks repro-recipe 0 … single-read 3", () => {
  assert.deepEqual(BASIS_ORDER, {
    "repro-recipe": 0,
    "two-read-cross-model": 1,
    "two-read-same-model": 2,
    "single-read": 3,
  });
});

test("rankScore: basis dominates, severity secondary, confidence tiebreak", () => {
  const weakRepro = rankScore({ basis: "repro-recipe", severity: "info", confidence: 0 });
  const strongSingle = rankScore({ basis: "single-read", severity: "critical", confidence: 1 });
  assert.ok(weakRepro > strongSingle, "basis must dominate severity+confidence");

  const crit = rankScore({ basis: "two-read-cross-model", severity: "critical", confidence: 0 });
  const low = rankScore({ basis: "two-read-cross-model", severity: "low", confidence: 1 });
  assert.ok(crit > low, "severity must beat confidence");

  const hi = rankScore({ basis: "single-read", severity: "medium", confidence: 0.9 });
  const lo = rankScore({ basis: "single-read", severity: "medium", confidence: 0.1 });
  assert.ok(hi > lo, "confidence breaks ties");
});

test("sortFindings orders repro-recipe first, single-read last, stable", () => {
  const bases: FindingBasis[] = ["single-read", "repro-recipe", "two-read-same-model", "two-read-cross-model"];
  const input = bases.map((basis, i) => ({ basis, severity: "medium" as const, confidence: 0.5, n: i }));
  const sorted = sortFindings(input);
  assert.deepEqual(
    sorted.map((f) => f.basis),
    ["repro-recipe", "two-read-cross-model", "two-read-same-model", "single-read"],
  );
  // stability: equal keys keep input order
  const ties = sortFindings([
    { basis: "single-read" as const, severity: "low" as const, confidence: 0, n: 1 },
    { basis: "single-read" as const, severity: "low" as const, confidence: 0, n: 2 },
  ]);
  assert.deepEqual(ties.map((f) => f.n), [1, 2]);
});

test("sectionFor labels are honest and never say confirmed", () => {
  assert.equal(sectionFor("repro-recipe"), "Leads with recipes");
  assert.equal(sectionFor("two-read-cross-model"), "Two reads, cross-model");
  assert.equal(sectionFor("two-read-same-model"), "Two reads, same model — verify first");
  assert.equal(sectionFor("single-read"), "Single read — kill or promote");
  assert.equal(sectionFor({ basis: "repro-recipe", status: "disputed" }), "Disputed");
  for (const b of Object.keys(BASIS_ORDER) as FindingBasis[]) {
    assert.doesNotMatch(sectionFor(b), /confirm/i);
  }
  assert.doesNotMatch(sectionFor({ basis: "single-read", status: "disputed" }), /confirm/i);
});

test("deriveCheckCost counts files and returns a minute range", () => {
  const c0 = deriveCheckCost("repro-recipe", 0);
  assert.equal(c0.filesToOpen, 1);
  assert.match(c0.estMinutes, /min/);
  const c3 = deriveCheckCost("single-read", 3);
  assert.equal(c3.filesToOpen, 4);
  assert.match(c3.estMinutes, /min/);
});
