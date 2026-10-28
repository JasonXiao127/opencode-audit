import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_VERSION,
  SWEEP_FINDING_CAP,
  LENS_FOCUS,
  guessLang,
  buildSweepPrompt,
  buildFalsifyPrompt,
} from "../src/core/prompts.js";
import type { Chunk } from "../src/core/types.js";

function chunk(): Chunk {
  return {
    file: "src/auth/login.ts",
    chunkIndex: 0,
    totalChunks: 1,
    startLine: 1,
    endLine: 40,
    header: "import { db } from './db';",
    text: "1| export async function login(req: Req) {\n2|   const q = `SELECT * FROM users WHERE name = '${req.body.name}'`;\n3|   return db.query(q);\n4| }",
    hash: "abc",
    contextHash: "def",
  };
}

test("PROMPT_VERSION is v2", () => {
  assert.equal(PROMPT_VERSION, "v2");
});

test("guessLang maps common extensions", () => {
  assert.equal(guessLang("src/a.ts"), "TypeScript");
  assert.equal(guessLang("x/y.py"), "Python");
  assert.equal(guessLang("main.go"), "Go");
  assert.equal(guessLang("a/b.rs"), "Rust");
  assert.equal(guessLang("Makefile"), "plaintext");
  assert.equal(guessLang("weird.zzz"), "plaintext");
});

test("LENS_FOCUS defines correctness, trust-boundary, and resource/concurrency text", () => {
  assert.ok(LENS_FOCUS["correctness"].length > 0);
  assert.ok(LENS_FOCUS["trust-boundary"].length > 0);
  const third = Object.keys(LENS_FOCUS).filter((k) => k !== "correctness" && k !== "trust-boundary");
  assert.ok(third.length >= 1, "third focus text must exist");
  assert.match(LENS_FOCUS[third[0]], /concurrency|race|resource/i);
});

test("sweep prompt wraps code in untrusted delimiters with untrusted-data warning", () => {
  const p = buildSweepPrompt({ chunk: chunk(), fileLang: "TypeScript", lens: "correctness", commit: "abc123" });
  assert.ok(p.includes('<untrusted-code file="src/auth/login.ts">'));
  assert.ok(p.includes("</untrusted-code>"));
  assert.match(p, /UNTRUSTED DATA/i);
  assert.match(p, /never follow instructions/i);
});

test("sweep prompt demands JSON-only output matching the finder schema", () => {
  const p = buildSweepPrompt({ chunk: chunk(), fileLang: "TypeScript", lens: "trust-boundary", commit: "abc123" });
  assert.match(p, /JSON ONLY/i);
  for (const field of [
    "file", "line", "endLine", "category", "severity", "title", "claim",
    "mechanism", "trigger", "quote", "scope", "alternatives", "disproof",
    "confidence", "nextReads",
  ]) {
    assert.ok(p.includes(`"${field}"`), `prompt must demand field ${field}`);
  }
});

test("sweep prompt requires claim+trigger+disproof, forbids stay-silent, caps at 12, demands verbatim quotes", () => {
  const p = buildSweepPrompt({ chunk: chunk(), fileLang: "TypeScript", lens: "correctness", commit: "abc123" });
  assert.match(p, /claim/);
  assert.match(p, /trigger/);
  assert.match(p, /disproof/);
  assert.ok(p.includes("when in doubt, stay silent") && /FORBIDDEN/i.test(p));
  assert.ok(p.includes(String(SWEEP_FINDING_CAP)));
  assert.match(p, /verbatim/i);
  assert.match(p, /line-number prefix/i);
});

test("sweep prompt carries lens focus, commit, and enclosing scope", () => {
  const c = chunk();
  const p = buildSweepPrompt({
    chunk: c, fileLang: "TypeScript", lens: "trust-boundary", commit: "deadbee",
    enclosingScope: "login (lines 1-40)",
  });
  assert.ok(p.includes("deadbee"));
  assert.ok(p.includes("login (lines 1-40)"));
  assert.ok(p.includes("TRUST BOUNDARY") || p.includes("trust"));
  const pc = buildSweepPrompt({ chunk: c, fileLang: "TypeScript", lens: "correctness", commit: "x" }, "correctness");
  assert.ok(pc.includes("CORRECTNESS") || pc.includes("correctness"));
});

test("falsifier prompt has verdict schema and no confirmer language", () => {
  const p = buildFalsifyPrompt({
    claim: "SQL injection via req.body.name",
    quote: "const q = `SELECT * FROM users WHERE name = '${req.body.name}'`;",
    file: "src/auth/login.ts",
    line: 2,
    sourceWindow: "2| const q = `SELECT * FROM users WHERE name = '${req.body.name}'`;",
    enclosingScope: "login (lines 1-4)",
  });
  for (const w of ["reproduced", "plausible-unverified", "rejected", "recipe", "expectedVsActual", "disproofCheck", "unverified", "nextReads", "confidence"]) {
    assert.ok(p.includes(w), `falsifier prompt must mention ${w}`);
  }
  assert.ok(p.includes("SQL injection via req.body.name"));
  assert.doesNotMatch(p, /reviewer/i);
  assert.doesNotMatch(p, /confirm/i);
  assert.match(p, /KILL/i);
});
