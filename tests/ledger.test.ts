import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger, findingId } from "../src/core/ledger.js";
import type { FindingInput } from "../src/core/types.js";

function newLedger(): { ledger: Ledger; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
  const path = join(dir, "ledger.db");
  return { ledger: new Ledger(path), path };
}

function makeInput(over: Partial<FindingInput> = {}): FindingInput {
  return {
    file: "src/auth.ts",
    line: 100,
    endLine: 108,
    category: "correctness",
    severity: "high",
    title: "Off-by-one in verify loop",
    claim: "The loop bound lets index -1 through.",
    mechanism: "Uses <= instead of < on the length check.",
    trigger: "Call verify() with an empty list.",
    quote: "for (let i = 0; i <= xs.length; i++) {}",
    scope: "verify()",
    alternatives: ["guard at src/auth.ts:95 checked"],
    disproof: "If the bound is exclusive, this lead is dead.",
    confidence: 0.4,
    ...over,
  };
}

test("findingId is deterministic and AUD-XXXXXXXX shaped", () => {
  const { ledger } = newLedger();
  try {
    const a = ledger.findingId("src/a.ts", "quote", "correctness");
    const b = findingId("src/a.ts", "quote", "correctness");
    assert.equal(a, b);
    assert.match(a, /^AUD-[0-9A-F]{8}$/);
    assert.notEqual(a, ledger.findingId("src/a.ts", "other", "correctness"));
    assert.notEqual(a, ledger.findingId("src/b.ts", "quote", "correctness"));
  } finally {
    ledger.close();
  }
});

test("upsert inserts then merges finders without overwriting", () => {
  const { ledger, path } = newLedger();
  try {
    const input = makeInput();
    const id1 = ledger.upsertCandidate(input, "ctx-1", "stealth-a");
    assert.match(id1, /^AUD-[0-9A-F]{8}$/);
    const got = ledger.getFinding(id1);
    assert.ok(got);
    assert.equal(got.file, "src/auth.ts");
    assert.equal(got.line, 100);
    assert.equal(got.endLine, 108);
    assert.equal(got.status, "candidate");
    assert.equal(got.basis, "single-read");
    assert.equal(got.contextHash, "ctx-1");
    assert.deepEqual(got.alternatives, ["guard at src/auth.ts:95 checked"]);

    // Same candidate from another model: same id, single row, fields kept.
    const id2 = ledger.upsertCandidate({ ...input, title: "CHANGED", confidence: 0.99 }, "ctx-2", "stealth-b");
    assert.equal(id2, id1);
    assert.equal(ledger.listFindings().length, 1);
    const kept = ledger.getFinding(id1);
    assert.ok(kept);
    assert.equal(kept.title, "Off-by-one in verify loop");
    assert.equal(kept.confidence, 0.4);
    assert.equal(kept.contextHash, "ctx-1");
  } finally {
    ledger.close();
  }
  // Provenance merged both finders (inspected via raw SQL after close).
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT provenance FROM findings").get() as unknown as { provenance: string };
    const prov = JSON.parse(row.provenance) as { finders: string[] };
    assert.deepEqual([...prov.finders].sort(), ["stealth-a", "stealth-b"]);
  } finally {
    db.close();
  }
});

test("setStatus/setBasis/setConfidence and markMerged", () => {
  const { ledger } = newLedger();
  try {
    const id = ledger.upsertCandidate(makeInput(), "ctx", "m");
    ledger.setStatus(id, "seconded");
    ledger.setBasis(id, "two-read-cross-model");
    ledger.setConfidence(id, 0.7);
    const got = ledger.getFinding(id);
    assert.ok(got);
    assert.equal(got.status, "seconded");
    assert.equal(got.basis, "two-read-cross-model");
    assert.equal(got.confidence, 0.7);

    const dup = ledger.upsertCandidate(makeInput({ file: "src/other.ts" }), "ctx", "m");
    ledger.markMerged(dup, id);
    const dupRow = ledger.getFinding(dup);
    assert.ok(dupRow);
    assert.equal(dupRow.mergedInto, id);

    assert.equal(ledger.listFindings("seconded").length, 1);
    assert.equal(ledger.listFindings("candidate").length, 1);
    assert.equal(ledger.getFinding("AUD-FFFFFFFF"), undefined);
  } finally {
    ledger.close();
  }
});

test("votes, coverage, attempts, rejected, kv round-trip", () => {
  const { ledger } = newLedger();
  try {
    const id = ledger.upsertCandidate(makeInput(), "ctx", "stealth-a");
    ledger.addVote(id, "stealth-b", "verifier", "plausible-unverified", "looks real");
    ledger.addVote(id, "stealth-a", "finder", "candidate", "initial report");

    ledger.recordCoverage("chunk-1", "stealth-a", "v1", "src/auth.ts", 2);
    assert.equal(ledger.hasCoverage("chunk-1", "v1"), true);
    assert.equal(ledger.hasCoverage("chunk-1", "v2"), false);
    assert.equal(ledger.hasCoverage("chunk-9", "v1"), false);
    assert.deepEqual(ledger.filesWithCoverage(), ["src/auth.ts"]);

    ledger.recordAttempt({ model: "stealth-a", role: "finder", unit: "p1", outcome: "ok", ms: 1200, rawLen: 512 });
    ledger.recordRejected({ file: "src/x.ts", line: 3, title: "No trigger", reason: "missing trigger", model: "stealth-a" });
    ledger.recordRejected({ file: "src/y.ts", line: 4, title: "No disproof", reason: "missing disproof", model: "stealth-a" });
    const rej = ledger.listRejected(10);
    assert.equal(rej.length, 2);
    assert.equal(ledger.listRejected(1).length, 1);
    assert.ok(rej[0].createdAt > 0);

    assert.equal(ledger.kvGet("missing"), undefined);
    ledger.kvSet("scan_commit", "abc123");
    assert.equal(ledger.kvGet("scan_commit"), "abc123");
    ledger.kvSet("scan_commit", "def456");
    assert.equal(ledger.kvGet("scan_commit"), "def456");
  } finally {
    ledger.close();
  }
});
