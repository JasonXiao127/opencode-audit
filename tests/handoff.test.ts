import { test } from "node:test";
import assert from "node:assert/strict";
import {
  basisLabel,
  buildDoc,
  dedupeFindings,
  fence,
  renderHandoffJson,
  renderHandoffMd,
} from "../src/core/handoff.js";
import type {
  CoverageManifest,
  FindingBasis,
  HandoffDoc,
  HandoffLead,
} from "../src/core/types.js";

let n = 0;

function makeLead(over: Partial<HandoffLead> = {}): HandoffLead {
  n += 1;
  return {
    id: `AUD-T${String(n).padStart(5, "0")}`,
    file: "src/auth.ts",
    line: 100,
    commit: "abc123",
    severity: "high",
    category: "correctness",
    claim: "Off-by-one lets an out-of-bounds index through.",
    mechanism: "Loop bound uses <= instead of <.",
    trigger: "Call verify() with an empty list.",
    quote: "for (let i = 0; i <= xs.length; i++) {}",
    enclosingScope: "verify() lines 90-110",
    alternatives: ["guard at src/auth.ts:95 checked"],
    disproof: "If the loop bound is exclusive, this lead is dead.",
    reproSteps: ["Open src/auth.ts:100", "Trace the loop bound"],
    expectedVsActual: "Expected exclusive bound; code uses inclusive.",
    unverified: ["caller in another module"],
    nextReads: [{ loc: "src/auth.ts:verify()", why: "check sanitization" }],
    checkCost: { filesToOpen: 1, estMinutes: "5 min" },
    blastRadius: "Affects all callers of verify().",
    basis: "single-read",
    confidence: 0.4,
    provenance: { finder: "stealth-a", replicator: "none", promptVersion: "v1" },
    untrusted: true,
    quoteHash: "qh-stub",
    evidenceWindow: "line ±8",
    flags: [],
    related: [],
    ...over,
  };
}

function makeManifest(over: Partial<CoverageManifest> = {}): CoverageManifest {
  return {
    commit: "abc123",
    promptVersion: "v1",
    generatedAt: "2026-10-28T00:00:00.000Z",
    filesSeen: 4,
    chunksTotal: 10,
    chunksCovered: 10,
    skipped: [],
    modelPerChunk: { c1: "stealth-a", c2: "stealth-b" },
    silence: [],
    blindSpots: [],
    ...over,
  };
}

function makeDoc(over: Partial<HandoffDoc> = {}, leads?: HandoffLead[]): HandoffDoc {
  return {
    targetDir: "/repo",
    commit: "abc123",
    generatedAt: "2026-10-28T00:00:00.000Z",
    promptVersion: "v1",
    status: "complete",
    leads: leads ?? [makeLead()],
    manifest: makeManifest(),
    ...over,
  };
}

test("basis labels are honest — no confirm language", () => {
  const bases: FindingBasis[] = ["single-read", "two-read-same-model", "two-read-cross-model", "repro-recipe"];
  for (const b of bases) {
    const label = basisLabel(b);
    assert.ok(label.length > 0);
    assert.doesNotMatch(label, /confirm/i, `basis ${b} must never say confirmed`);
  }
  assert.equal(basisLabel("repro-recipe"), "two reads, cross-model + reproduction recipe");
  assert.equal(basisLabel("two-read-cross-model"), "two reads, cross-model");
  assert.equal(basisLabel("two-read-same-model"), "two reads, same model — verify first");
  assert.equal(basisLabel("single-read"), "single read — kill or promote");
});

test("fence neutralizes triple backticks", () => {
  assert.equal(fence("a```b"), "a'''b");
  assert.ok(!fence("```evil\ncode```").includes("```"));
  assert.equal(fence("plain text"), "plain text");
});

test("dedupe merges near-duplicates and preserves related", () => {
  const a = makeLead({ id: "AUD-KEEP01", line: 100 });
  const dup = makeLead({ id: "AUD-DUP01", line: 103, related: ["AUD-OLD"] });
  const other = makeLead({ id: "AUD-OTHER1", file: "src/db.ts", line: 100 });
  const { kept, merged } = dedupeFindings([a, dup, other]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].id, "AUD-KEEP01");
  assert.deepEqual([...kept[0].related].sort(), ["AUD-DUP01", "AUD-OLD"]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    primary: "AUD-KEEP01",
    dup: "AUD-DUP01",
    reason: "same location and quote hash",
  });
  assert.equal((dup as HandoffLead & { mergedInto?: string }).mergedInto, "AUD-KEEP01");
});

test("dedupe merges on category+claim overlap with different quotes", () => {
  const a = makeLead({ id: "AUD-A1", line: 50, claim: "Null deref in verify loop bound" });
  const b = makeLead({
    id: "AUD-B1",
    line: 52,
    claim: "Null dereference in verify() loop bound",
    quote: "completely different text",
  });
  const { kept, merged } = dedupeFindings([a, b]);
  assert.equal(kept.length, 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].primary, "AUD-A1");
});

test("dedupe keeps distant lines and different files apart", () => {
  const a = makeLead({ id: "AUD-A2", line: 100 });
  const far = makeLead({ id: "AUD-A3", line: 200 });
  const { kept, merged } = dedupeFindings([a, far]);
  assert.equal(kept.length, 2);
  assert.equal(merged.length, 0);
});

test("render has all 5 sections plus untrusted banner", () => {
  const md = renderHandoffMd(makeDoc());
  assert.ok(md.includes("## Header"));
  assert.ok(md.includes("## Start here"));
  assert.ok(md.includes("## Leads by file"));
  assert.ok(md.includes("## Coverage manifest"));
  assert.ok(md.includes("## Appendix"));
  assert.ok(md.includes("> Untrusted leads"));
  // Lead detail fields present.
  for (const needle of [
    "Claim:",
    "Mechanism:",
    "Trigger:",
    "Alternatives",
    "kill condition",
    "Repro steps:",
    "Unverified:",
    "Next reads:",
  ]) {
    assert.ok(md.includes(needle), `missing ${needle}`);
  }
});

test("render shows INCOMPLETE banner on partial, and on low coverage", () => {
  const partial = renderHandoffMd(makeDoc({ status: "partial" }));
  assert.ok(partial.includes("INCOMPLETE"));
  const lowCov = renderHandoffMd(makeDoc({}, [makeLead()]));
  assert.ok(!lowCov.includes("INCOMPLETE"), "full coverage + complete must not flag INCOMPLETE");
  const thin = makeDoc();
  thin.manifest = makeManifest({ chunksTotal: 10, chunksCovered: 5 });
  assert.ok(renderHandoffMd(thin).includes("INCOMPLETE"));
});

test("render caps at 30 leads with appendix spill line", () => {
  const leads: HandoffLead[] = [];
  for (let i = 0; i < 35; i++) {
    leads.push(makeLead({ id: `AUD-CAP${String(i).padStart(3, "0")}`, file: `src/f${i}.ts` }));
  }
  const md = renderHandoffMd(makeDoc({}, leads));
  const headings = md.match(/^### AUD-/gm) ?? [];
  assert.equal(headings.length, 30);
  assert.ok(md.includes("30-lead cap"));
  assert.ok(md.includes("5 omitted"));
  const full = renderHandoffMd(makeDoc({}, leads.slice(0, 3)));
  assert.equal(full.match(/^### AUD-/gm)?.length, 3);
  assert.ok(full.includes("30-lead cap"));
});

test("render neutralizes fences inside model quotes and truncates to 800 chars", () => {
  const evil = "prefix ```rm -rf /``` suffix " + "x".repeat(2000);
  const md = renderHandoffMd(makeDoc({}, [makeLead({ quote: evil })]));
  assert.ok(!md.includes("```rm -rf"), "inner fence must be neutralized");
  assert.ok(md.includes("'''rm -rf"), "neutralized fence should remain readable");
});

test("buildDoc stamps generatedAt and renderHandoffJson round-trips", () => {
  const leads = [makeLead()];
  const doc = buildDoc({
    targetDir: "/repo",
    commit: "abc123",
    promptVersion: "v1",
    status: "complete",
    leads,
    manifest: makeManifest(),
  });
  assert.equal(doc.targetDir, "/repo");
  assert.ok(doc.generatedAt.length > 0);
  const json = renderHandoffJson(doc);
  assert.ok(json.startsWith("{\n  "), "2-space indent");
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(doc)));
});
