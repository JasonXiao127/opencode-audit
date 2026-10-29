// End-to-end JobRunner tests with a fake model transport.
// No network, no real models: canned JSON responses exercise the full
// probe/hunt/dedupe/budget/partial pipeline on temp git repos.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../src/audit/jobRunner.js";
import { readSummaries, renderStatsText } from "../src/audit/runlog.js";
import { parseModelKey, familyOf } from "../src/core/models.js";
import type { GenerateFn, JobPolicy } from "../src/audit/jobRunner.js";
import type { RunSummary } from "../src/core/types.js";

const AUTH_TS = `import { db } from "./db.js";
export function login(user: string, pass: string) {
  const q = "SELECT * FROM users WHERE name = '" + user + "'";
  return db.query(q);
}
`;

const UTIL_TS = `export function add(a: number, b: number) {
  return a + b;
}
`;

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

function makeRepo(files: Record<string, string>, commit = true): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-e2e-"));
  for (const [f, content] of Object.entries(files)) {
    const abs = join(dir, f);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  git(["init", "-b", "main", "-q"], dir);
  git(["add", "-A"], dir);
  if (commit) git(["commit", "-qm", "init"], dir);
  return dir;
}

const FINDER_TWO = JSON.stringify({
  findings: [
    {
      file: "src/auth.ts", line: 3, category: "security", severity: "critical", title: "SQL injection",
      claim: "login builds a SQL string by concatenating user input",
      mechanism: "user flows into the query string sent to db.query",
      trigger: "call login with user set to `' OR '1'='1`",
      quote: `const q = "SELECT * FROM users WHERE name = '" + user + "'";`,
      scope: "login", alternatives: [], disproof: "query uses parameters or escaping",
      confidence: 0.8, nextReads: [],
    },
    {
      file: "src/auth.ts", line: 4, category: "correctness", severity: "medium", title: "Unvalidated rows",
      claim: "db rows are returned to the caller without validation",
      mechanism: "query result passes straight through",
      trigger: "call login with any valid user and inspect the returned rows",
      quote: "return db.query(q);",
      scope: "login", alternatives: [], disproof: "rows are validated downstream",
      confidence: 0.5, nextReads: [],
    },
    {
      file: "src/auth.ts", line: 2, category: "logic", severity: "low", title: "No trigger lead",
      claim: "something vague", mechanism: "m",
      quote: "export function login(user: string, pass: string) {",
      disproof: "d", confidence: 0.3,
    },
  ],
});

const FALSIFY_REPRO = JSON.stringify({
  verdict: "reproduced", reason: "injection reaches the query",
  recipe: ["call login with user `' OR '1'='1`", "observe all rows returned"],
  expectedVsActual: "expected one user; code returns every row",
  alternatives: ["checked callers: none sanitize"],
  disproofCheck: "no parameterization found", unverified: [],
  nextReads: ["src/db.ts:query — check driver"], confidence: 0.8,
});

const FALSIFY_REJECT = JSON.stringify({
  verdict: "rejected", reason: "rows are validated by the caller contract",
  recipe: [], expectedVsActual: "", alternatives: ["caller validates"],
  disproofCheck: "validated downstream", unverified: [], nextReads: [], confidence: 0.9,
});

function fake(scripts: { finder: (file: string) => string; falsify: (file: string, line: number) => string }): GenerateFn {
  return async (_model, prompt) => {
    if (prompt.startsWith("You are a falsifier")) {
      const m = /Location: ([^:]+):(\d+)/.exec(prompt);
      return scripts.falsify(m?.[1] ?? "", Number(m?.[2] ?? 0));
    }
    const m = /Target: (\S+)/.exec(prompt);
    return scripts.finder(m?.[1] ?? "");
  };
}

const MODELS = ["stealth/model-a", "paid/model-b"];
const basePolicy: JobPolicy = {
  scope: "full",
  tier: "probe",
  models: MODELS,
  wallMs: 60_000,
};

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("jobRunner", () => {
  let dir = "";
  before(() => {
    dir = makeRepo({ "src/auth.ts": AUTH_TS, "src/util.ts": UTIL_TS });
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("probe writes handoff, manifest, logs, and honest single-read basis", async () => {
    const gen = fake({
      finder: (f) => (f === "src/auth.ts" ? FINDER_TWO : `{"findings": []}`),
      falsify: () => FALSIFY_REJECT,
    });
    const r = await runJob({ generate: gen }, dir, { ...basePolicy });
    assert.equal(r.partial, false);
    assert.equal(r.stats.leads, 2);
    const doc = JSON.parse(readFileSync(r.jsonPath, "utf8")) as { leads: { basis: string; untrusted: boolean; commit: string }[] };
    assert.ok(doc.leads.every((l) => l.basis === "single-read"));
    assert.ok(doc.leads.every((l) => l.untrusted === true));
    assert.ok(doc.leads.every((l) => typeof l.commit === "string" && l.commit.length > 0));
    const md = readFileSync(r.handoffPath, "utf8");
    assert.ok(!md.includes("confirmed by another model"));
    assert.ok(md.includes("Untrusted leads"));
    assert.equal(r.summary.funnel.raw, 2);
    assert.equal(r.summary.funnel.evidencePassed, 2);
    assert.equal(r.summary.funnel.replicatorAttempted, 0);
    const events = readJsonl(r.logPath);
    assert.ok(events.some((e) => e["type"] === "finder.dropped" && e["reason"] === "no-trigger"));
  });

  it("hunt reproduces one lead and kills the other with logged reasons", async () => {
    const gen = fake({
      finder: (f) => (f === "src/auth.ts" ? FINDER_TWO : `{"findings": []}`),
      falsify: (_f, line) => (line === 3 ? FALSIFY_REPRO : FALSIFY_REJECT),
    });
    const r = await runJob({ generate: gen }, dir, { ...basePolicy, tier: "hunt" });
    assert.equal(r.summary.funnel.replicatorAttempted, 2);
    assert.equal(r.summary.funnel.reproduced, 1);
    assert.equal(r.summary.funnel.rejected, 1);
    assert.equal(r.summary.killRate.overall, 0.5);
    const doc = JSON.parse(readFileSync(r.jsonPath, "utf8")) as {
      leads: { id: string; line: number; basis: string; reproSteps: string[]; status?: string }[];
    };
    const byLine = new Map(doc.leads.map((l) => [l.line, l]));
    assert.equal(byLine.get(3)?.basis, "repro-recipe");
    assert.ok((byLine.get(3)?.reproSteps?.length ?? 0) > 0);
    const events = readJsonl(r.logPath);
    assert.ok(events.some((e) => e["type"] === "lead.killed" && e["stage"] === "replicator"));
    assert.ok(events.some((e) => e["type"] === "lead.promoted"));
    assert.ok(events.some((e) => e["type"] === "replicator.verdict"));
  });

  it("lead budget spills non-critical leads with reasons", async () => {
    const d3 = makeRepo({ "src/auth.ts": AUTH_TS, "src/util.ts": UTIL_TS });
    try {
      const gen = fake({
        finder: () => FINDER_TWO,
        falsify: () => FALSIFY_REJECT,
      });
      const r = await runJob({ generate: gen }, d3, { ...basePolicy, leadBudget: 1 });
      assert.equal(r.summary.funnel.leadBudgetSpill, 1);
      const events = readJsonl(r.logPath);
      assert.ok(events.some((e) => e["type"] === "lead.killed" && e["stage"] === "lead-budget"));
    } finally {
      rmSync(d3, { recursive: true, force: true });
    }
  });

  it("maxCalls caps model calls and marks the run partial", async () => {
    const d5 = makeRepo({ "src/auth.ts": AUTH_TS, "src/util.ts": UTIL_TS });
    try {
      let genCalls = 0;
      const gen: GenerateFn = async () => {
        genCalls += 1;
        return `{"findings": []}`;
      };
      const r = await runJob({ generate: gen }, d5, { ...basePolicy, maxCalls: 1 });
      assert.ok(genCalls <= 1, `expected <=1 generate call, got ${genCalls}`);
      assert.equal(r.partial, true);
      assert.equal(r.summary.status, "partial");
    } finally {
      rmSync(d5, { recursive: true, force: true });
    }
  });

  it("no models configured yields a partial handoff with a blind spot", async () => {
    const gen: GenerateFn = async () => `{"findings": []}`;
    const r = await runJob({ generate: gen }, dir, { ...basePolicy, models: [] });
    assert.equal(r.partial, true);
    assert.ok(r.summary.coverage.blindSpots.some((b) => /no models/i.test(b)));
    const md = readFileSync(r.handoffPath, "utf8");
    assert.ok(md.includes("INCOMPLETE"));
  });

  it("total model failure still writes a partial handoff", async () => {
    const d4 = makeRepo({ "src/auth.ts": AUTH_TS, "src/util.ts": UTIL_TS });
    try {
      const gen: GenerateFn = async () => {
        throw new Error("model not found: gone");
      };
      const r = await runJob({ generate: gen }, d4, { ...basePolicy });
      assert.equal(r.partial, true);
      const md = readFileSync(r.handoffPath, "utf8");
      assert.ok(md.includes("INCOMPLETE"));
      assert.equal(r.summary.status, "partial");
    } finally {
      rmSync(d4, { recursive: true, force: true });
    }
  });

  it("diff scope sweeps only changed modules", async () => {
    const d2 = makeRepo({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "src/c.ts": "export const c = 3;\n" });
    try {
      writeFileSync(join(d2, "src/b.ts"), "export const b = 2;\n// touched\n");
      const gen = fake({ finder: () => `{"findings": []}`, falsify: () => FALSIFY_REJECT });
      const r = await runJob({ generate: gen }, d2, { ...basePolicy, scope: "diff" });
      assert.equal(r.summary.coverage.filesSeen, 1);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });

  it("stats renders the funnel from real summaries", async () => {
    const gen = fake({ finder: () => `{"findings": []}`, falsify: () => FALSIFY_REJECT });
    const r = await runJob({ generate: gen }, dir, basePolicy);
    const summaries = readSummaries(join(dir, ".audit", "logs"), 10);
    assert.ok(summaries.length >= 1);
    const text = renderStatsText(summaries);
    assert.ok(text.includes("funnel raw="));
    assert.ok(text.includes("kill-rate="));
    assert.ok(text.includes(`run ${r.summary.runId}`));
  });
});

describe("models", () => {
  it("familyOf groups variants, splits providers", () => {
    assert.equal(familyOf("opencode/nemotron-3-ultra-free"), familyOf("opencode/nemotron-3.5-lightning-free"));
    assert.notEqual(familyOf("opencode/nemotron-3-ultra-free"), familyOf("other/nemotron-3-ultra-free"));
    assert.equal(familyOf("a/b-c-d#max"), "a/b");
  });
  it("parseModelKey splits provider, id, variant", () => {
    assert.deepEqual(parseModelKey("a/b#c"), { providerID: "a", id: "b", variant: "c" });
    assert.deepEqual(parseModelKey("a/b"), { providerID: "a", id: "b" });
  });
});
