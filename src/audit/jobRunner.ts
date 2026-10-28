// One-shot audit job: inventory/diff → partition → sweep → evidence →
// replicator → dedupe → handoff. No timers, no ownership, no daemon.
// Exits when the queue drains or a budget is hit; always writes a handoff.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger } from "../core/ledger.js";
import { inventory, changedFiles, headCommit } from "../core/inventory.js";
import { chunkFile, findingContext } from "../core/chunk.js";
import { moduleOf, buildImportMap, partitionFiles, resolveImportSpecifier, expandScope } from "../core/partition.js";
import { buildSweepPrompt, buildFalsifyPrompt, guessLang, PROMPT_VERSION } from "../core/prompts.js";
import {
  parseFindings,
  parseReplicator,
  checkEvidence,
  quoteHash,
  repetitionScore,
} from "../core/evidence.js";
import { BASIS_ORDER, deriveCheckCost } from "../core/ranking.js";
import { dedupeFindings, buildDoc, renderHandoffMd, renderHandoffJson, computeFlags, redactQuote } from "../core/handoff.js";
import { familyOf, parseModelKey } from "../core/models.js";
import { RunLog, writeSummaryFile } from "./runlog.js";
import type {
  Chunk,
  CoverageManifest,
  Finding,
  FindingBasis,
  HandoffLead,
  JobPolicy,
  JobResult,
  Lens,
  ModelRef,
  ReplicatorVerdict,
  Severity,
  SilenceStat,
  SkippedFile,
} from "../core/types.js";

export type { JobPolicy, ModelRef, Lens, Severity, Finding, FindingBasis } from "../core/types.js";

export interface GenerateFn {
  (model: ModelRef, prompt: string, timeoutMs: number): Promise<string>;
}

export interface JobDeps {
  generate: GenerateFn;
}

const SWEEP_TIMEOUT_MS = 90_000;
const REPLICATOR_TIMEOUT_MS = 60_000;
const MAX_CHUNK_CHARS = 40_000;
const LEAD_BUDGET_DEFAULT = 200;
const VERIFY_BUDGET_DEFAULT = 50;
const HANDOFF_CAP = 30;
const WALL_MS_DEFAULT = 45 * 60_000;

const SECURITY_PATH =
  /auth|crypto|login|password|token|secret|session|cookie|jwt|oauth|permission|role|admin|route|middleware|\bsso\b|sanit|valid|escape|sql|query|fetch|request|signin|signup/i;

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type ErrorKind = "e429" | "missing" | "timeout" | "error";

function classifyError(e: unknown): ErrorKind {
  const msg = String((e as Error)?.message ?? e);
  if (/^timeout after/i.test(msg) || /timed out/i.test(msg)) return "timeout";
  if (/429|quota|rate.?limit|free.*exceed/i.test(msg)) return "e429";
  if (/not found|deprecated|disabled|unknown model|no longer|model.*(?:gone|removed)/i.test(msg)) return "missing";
  return "error";
}

function lensFor(file: string, scope: "diff" | "full"): Lens {
  if (SECURITY_PATH.test(file)) return "trust-boundary";
  return "correctness";
}

function enclosingScopeFor(lines: string[], line: number): string {
  const start = Math.max(0, line - 41);
  for (let i = line - 1; i >= start; i--) {
    const t = (lines[i] ?? "").trim().slice(0, 160);
    const m = /^(?:export\s+)?(?:async\s+)?(?:function|class|def|fn|func|trait|interface|struct|enum)\s+([A-Za-z0-9_]+)/.exec(t)
      ?? /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/.exec(t);
    if (m) return `${m[1]} (near line ${i + 1})`;
  }
  return "module scope";
}

function numberedWindow(lines: string[], line: number, radius: number): string {
  const lo = Math.max(1, line - radius);
  const hi = Math.min(lines.length, line + radius);
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push(`${i}| ${lines[i - 1] ?? ""}`);
  return out.join("\n");
}

interface SweepUnit {
  file: string;
  chunk: Chunk;
  model: string;
  status: "pending" | "running" | "done";
  retried: boolean;
}

export async function runJob(deps: JobDeps, repo: string, policy: JobPolicy): Promise<JobResult> {
  const targetDir = resolve(repo);
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${Math.random().toString(36).slice(2, 8)}`;
  const commit = headCommit(targetDir);
  const promptVersion = policy.promptVersion ?? PROMPT_VERSION;
  const wallMs = policy.wallMs ?? WALL_MS_DEFAULT;
  const wallDeadline = Date.now() + wallMs;
  const leadBudget = policy.leadBudget ?? LEAD_BUDGET_DEFAULT;
  const verifyBudget = policy.verifyBudget ?? VERIFY_BUDGET_DEFAULT;
  const perModelMax = policy.perModelMax ?? 3;
  const globalMax = policy.globalMax ?? 12;
  const models = [...policy.models];
  const tier = policy.tier;
  const scope = policy.scope;

  const auditDir = join(targetDir, ".audit");
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(join(auditDir, "logs"), { recursive: true });
  const gi = join(auditDir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
  const ledger = new Ledger(join(auditDir, "audit.db"));
  const log = new RunLog(join(auditDir, "logs", `run-${runId}.jsonl`), {
    runId,
    targetDir,
    commit,
    scope,
    tier,
    promptVersion,
  });
  log.emit({ type: "run.started", models, policy: { ...policy } });

  let calls = 0;
  let partial = false;
  const skipped: SkippedFile[] = [];
  const contents = new Map<string, { lines: string[]; text: string }>();
  const finderOf = new Map<string, string>();
  const replicatorOf = new Map<string, string>();
  const silSweeps = new Map<string, { sweeps: number; silent: number }>();
  let rawCount = 0;
  let chunksTotal = 0;

  const cooldownUntil = new Map<string, number>();
  const retired = new Set<string>();
  const inFlight = new Map<string, number>();
  let inFlightGlobal = 0;
  const caps = new Map<string, number>();

  const capOf = (m: string): number => caps.get(m) ?? perModelMax;
  const modelUsable = (m: string, now: number): boolean =>
    !retired.has(m) &&
    (cooldownUntil.get(m) ?? 0) <= now &&
    (inFlight.get(m) ?? 0) < capOf(m) &&
    inFlightGlobal < globalMax;
  const liveModels = (): string[] => models.filter((m) => !retired.has(m));

  const recordCall = (model: string, ms: number, outcome: "ok" | "e429" | "timeout" | "json-invalid" | "missing" | "error", rawLen = 0): void => {
    log.recordCall(model, ms, outcome, rawLen);
    ledger.recordAttempt({ model, role: "sweep", unit: "", outcome, ms, rawLen });
  };

  const failModel = (model: string, kind: ErrorKind): void => {
    if (kind === "e429") {
      cooldownUntil.set(model, Date.now() + 60_000);
      caps.set(model, Math.max(1, Math.floor(capOf(model) / 2)));
    } else if (kind === "missing") {
      retired.add(model);
      log.emit({ type: "run.failed", model, reason: `model retired: ${kind}` });
    } else if (kind === "timeout") {
      cooldownUntil.set(model, Date.now() + 30_000);
    }
  };

  const readRepoFile = (file: string): string[] | null => {
    const hit = contents.get(file);
    if (hit) return hit.lines;
    try {
      const text = readFileSync(join(targetDir, file), "utf8");
      const lines = text.split("\n");
      contents.set(file, { lines, text });
      return lines;
    } catch {
      return null;
    }
  };

  try {
    // -- scope ----------------------------------------------------------------
    const all = inventory(targetDir, { maxFileBytes: 1_000_000 });
    let scoped = all;
    if (scope === "diff") {
      const changed = changedFiles(targetDir);
      if (changed.size > 0) {
        const withContent = all
          .filter((e) => changed.has(e.file))
          .map((e) => {
            const lines = readRepoFile(e.file);
            return lines ? { file: e.file, content: lines.join("\n") } : null;
          })
          .filter((x): x is { file: string; content: string } => x !== null);
        const importMap0 = buildImportMap(withContent);
        const expanded = expandScope(changed, importMap0, all.map((e) => e.file));
        scoped = all.filter((e) => expanded.has(e.file));
      }
    }
    const filesSeen = scoped.length;
    for (const e of scoped) {
      if (!readRepoFile(e.file)) skipped.push({ file: e.file, reason: "unreadable" });
    }
    const readable = scoped.filter((e) => contents.has(e.file));

    // -- partition -------------------------------------------------------------
    const importMap = buildImportMap(
      readable.map((e) => ({ file: e.file, content: contents.get(e.file)!.text })),
    );
    const partitions = partitionFiles(readable.map((e) => ({ file: e.file, chars: contents.get(e.file)!.text.length })));
    const allFiles = readable.map((e) => e.file);
    const fileSet = new Set(allFiles);
    const boundaryOf = new Map<string, string>();
    const callersOf = new Map<string, string[]>();
    for (const p of partitions) {
      log.emit({ type: "partition.created", partitionId: p.id, files: p.files, chars: p.chars });
      void p;
    }
    for (const e of readable) {
      const entry = importMap.get(e.file);
      const mod = moduleOf(e.file);
      const imps = entry?.imports ?? [];
      const exps = entry?.exports ?? [];
      const edges = new Set<string>();
      const callers = new Set<string>();
      for (const [other, oEntry] of importMap) {
        if (other === e.file) continue;
        for (const spec of oEntry.imports) {
          if (resolveImportSpecifier(other, spec, fileSet) === e.file) callers.add(moduleOf(other));
        }
      }
      for (const s of imps) {
        const t = resolveImportSpecifier(e.file, s, fileSet);
        if (t && moduleOf(t) !== mod) edges.add(`${mod} -> ${moduleOf(t)}`);
      }
      callersOf.set(e.file, [...callers].sort());
      boundaryOf.set(
        e.file,
        `Module ${mod} · exports: ${exps.slice(0, 20).join(", ") || "—"} · imports: ${imps.slice(0, 20).join(", ") || "—"} · edges: ${[...edges].slice(0, 10).join("; ") || "—"}`,
      );
    }

    // -- sweep ------------------------------------------------------------------
    const units: SweepUnit[] = [];
    let rr = 0;
    for (const e of readable) {
      const text = contents.get(e.file)!.text;
      const chunks = chunkFile(e.file, text, MAX_CHUNK_CHARS);
      for (const c of chunks) {
        if (models.length === 0) break;
        units.push({ file: e.file, chunk: c, model: models[rr++ % models.length], status: "pending", retried: false });
      }
    }
    // Priority: non-test, non-huge partitions first (priority 0), then -1.
    const prio = new Map<string, number>();
    for (const p of partitions) for (const f of p.files) prio.set(f, p.priority);
    units.sort((a, b) => (prio.get(b.file) ?? 0) - (prio.get(a.file) ?? 0));
    chunksTotal = units.length;

    const processUnit = async (u: SweepUnit): Promise<void> => {
      const now = Date.now();
      if (now > wallDeadline) {
        u.status = "done";
        partial = true;
        return;
      }
      if (ledger.hasCoverage(u.chunk.hash, promptVersion)) {
        u.status = "done";
        return;
      }
      u.status = "running";
      inFlight.set(u.model, (inFlight.get(u.model) ?? 0) + 1);
      inFlightGlobal += 1;
      const lens = lensFor(u.file, scope);
      const lines = readRepoFile(u.file);
      if (!lines) {
        skipped.push({ file: u.file, reason: "unreadable" });
        u.status = "done";
        inFlight.set(u.model, (inFlight.get(u.model) ?? 1) - 1);
        inFlightGlobal -= 1;
        return;
      }
      const prompt = buildSweepPrompt(
        {
          chunk: u.chunk,
          fileLang: guessLang(u.file),
          lens,
          commit,
          enclosingScope: boundaryOf.get(u.file),
        },
        lens,
      );
      const ref = parseModelKey(u.model);
      const modelRef: ModelRef = { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) };
      const t0 = Date.now();
      let raw = "";
      try {
        raw = await withTimeout(deps.generate(modelRef, prompt, SWEEP_TIMEOUT_MS), SWEEP_TIMEOUT_MS, `sweep:${u.file}`);
      } catch (e) {
        const kind = classifyError(e);
        const ms = Date.now() - t0;
        calls += 1;
        recordCall(u.model, ms, kind, 0);
        ledger.recordRejected({ file: u.file, line: u.chunk.startLine, title: "(sweep failed)", reason: `generate ${kind}`, model: u.model });
        failModel(u.model, kind);
        inFlight.set(u.model, (inFlight.get(u.model) ?? 1) - 1);
        inFlightGlobal -= 1;
        if (kind === "missing") {
          const alt = liveModels().find((m) => m !== u.model);
          if (alt && !u.retried) {
            u.model = alt;
            u.status = "pending";
            u.retried = true;
            return;
          }
        } else if (!u.retried) {
          u.status = "pending";
          u.retried = true;
          return;
        }
        u.status = "done";
        partial = true;
        return;
      }
      const ms = Date.now() - t0;
      calls += 1;
      const sil = silSweeps.get(u.model) ?? { sweeps: 0, silent: 0 };
      sil.sweeps += 1;

      const loop = repetitionScore(raw);
      if (loop.score >= 0.7) {
        recordCall(u.model, ms, "json-invalid", raw.length);
        ledger.recordRejected({ file: u.file, line: u.chunk.startLine, title: "(loop discarded)", reason: loop.reasons.join("; "), model: u.model });
        log.emit({ type: "finder.dropped", model: u.model, lens, partitionId: u.file, reason: `loop: ${loop.reasons.join("; ")}` });
        sil.silent += 1;
        silSweeps.set(u.model, sil);
        u.status = "done";
        inFlight.set(u.model, (inFlight.get(u.model) ?? 1) - 1);
        inFlightGlobal -= 1;
        return;
      }

      const parsed = parseFindings(raw);
      if (parsed.jsonInvalid) {
        recordCall(u.model, ms, "json-invalid", raw.length);
        ledger.recordRejected({ file: u.file, line: u.chunk.startLine, title: "(invalid JSON)", reason: "unparseable model output", model: u.model });
        log.emit({ type: "finder.dropped", model: u.model, lens, partitionId: u.file, reason: "json-invalid" });
        u.status = "done";
        inFlight.set(u.model, (inFlight.get(u.model) ?? 1) - 1);
        inFlightGlobal -= 1;
        return;
      }
      recordCall(u.model, ms, "ok", raw.length);
      log.emit({ type: "finder.reported", model: u.model, lens, partitionId: u.file, count: parsed.findings.length });
      for (const s of parsed.skipped) {
        ledger.recordRejected({ file: u.file, line: s.line, title: s.title, reason: s.reason, model: u.model });
        log.emit({ type: "finder.dropped", model: u.model, lens, partitionId: u.file, reason: s.reason });
      }
      let kept = 0;
      for (const f of parsed.findings) {
        if (f.file !== u.file) {
          ledger.recordRejected({ file: u.file, line: f.line ?? 0, title: f.title.slice(0, 120), reason: `wrong file: cited ${f.file || "(empty)"}`, model: u.model });
          log.emit({ type: "finder.dropped", model: u.model, lens, partitionId: u.file, reason: "wrong-file" });
          continue;
        }
        if (!f.line || f.line < u.chunk.startLine || f.line > u.chunk.endLine) {
          ledger.recordRejected({ file: u.file, line: f.line ?? 0, title: f.title.slice(0, 120), reason: `line outside chunk ${u.chunk.startLine}-${u.chunk.endLine}`, model: u.model });
          log.emit({ type: "finder.dropped", model: u.model, lens, partitionId: u.file, reason: "line-outside-chunk" });
          continue;
        }
        const ev = checkEvidence(f, lines);
        if (!ev.ok) {
          ledger.recordRejected({ file: u.file, line: f.line, title: f.title.slice(0, 120), reason: ev.reason ?? "evidence gate", model: u.model });
          log.emit({ type: "finder.dropped", model: u.model, lens, partitionId: u.file, reason: ev.reason ?? "evidence-gate" });
          continue;
        }
        if (rawCount >= leadBudget && f.severity !== "critical" && f.severity !== "high") {
          ledger.recordRejected({ file: u.file, line: f.line, title: f.title.slice(0, 120), reason: "lead-budget spill", model: u.model });
          log.addLeadBudgetSpill(1);
          log.emit({ type: "lead.killed", stage: "lead-budget", reason: "budget spill (non-critical)", model: u.model, lens });
          continue;
        }
        kept += 1;
        rawCount += 1;
        const ctx = findingContext(lines, f.line);
        const id = ledger.upsertCandidate(
          {
            ...f,
            confidence: Math.min(0.5, Math.max(0, f.confidence || 0.5)),
          },
          ctx,
          u.model,
        );
        finderOf.set(id, u.model);
        ledger.addVote(id, u.model, "finder", "confirm", "initial report");
        log.emit({ type: "lead.created", leadId: id, model: u.model, lens, partitionId: u.file });
      }
      if (kept === 0) sil.silent += 1;
      silSweeps.set(u.model, sil);
      ledger.recordCoverage(u.chunk.hash, u.model, promptVersion, u.file, kept);
      u.status = "done";
      inFlight.set(u.model, (inFlight.get(u.model) ?? 1) - 1);
      inFlightGlobal -= 1;
    };

    const takeNext = (): SweepUnit | null => {
      const now = Date.now();
      for (const u of units) {
        if (u.status !== "pending") continue;
        if (retired.has(u.model)) {
          const alt = liveModels().find((m) => modelUsable(m, now));
          if (alt) {
            u.model = alt;
            if (modelUsable(u.model, now)) return u;
          }
          continue;
        }
        if (modelUsable(u.model, now)) return u;
      }
      return null;
    };

    const fiberCount = Math.min(globalMax, Math.max(1, units.length));
    await Promise.all(
      Array.from({ length: fiberCount }, () => (async () => {
        for (;;) {
          if (Date.now() > wallDeadline) {
            partial = true;
            return;
          }
          const u = takeNext();
          if (!u) {
            if (units.every((x) => x.status === "done")) return;
            if (liveModels().length === 0) {
              partial = true;
              return;
            }
            await sleep(75);
            continue;
          }
          await processUnit(u);
        }
      })()),
    );

    // -- hunt: replicator -------------------------------------------------------
    const replicatorOfLocal = replicatorOf;
    if (tier === "hunt" && Date.now() <= wallDeadline && liveModels().length > 0) {
      const cands = ledger
        .listFindings("candidate")
        .filter((f) => !f.mergedInto)
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence || (a.id < b.id ? -1 : 1))
        .slice(0, verifyBudget);
      for (const batch of chunkArr(cands, Math.max(1, globalMax))) {
        if (Date.now() > wallDeadline) {
          partial = true;
          break;
        }
        await Promise.allSettled(batch.map((f) => verifyOne(f)));
      }
    }

    async function verifyOne(f: Finding): Promise<void> {
      const lines = readRepoFile(f.file);
      if (!lines) return;
      if (findingContext(lines, f.line) !== f.contextHash) {
        log.emit({ type: "lead.killed", leadId: f.id, stage: "replicator", reason: "code-drift" });
        return;
      }
      const ev = checkEvidence({ line: f.line, quote: f.quote }, lines);
      if (!ev.ok) {
        log.emit({ type: "lead.killed", leadId: f.id, stage: "replicator", reason: "quote-drift" });
        return;
      }
      const finder = finderOf.get(f.id) ?? "";
      const finderFamily = finder ? familyOf(finder) : "";
      const now = Date.now();
      const indep = liveModels().filter((m) => familyOf(m) !== finderFamily && (cooldownUntil.get(m) ?? 0) <= now);
      const same = liveModels().filter((m) => familyOf(m) === finderFamily && (cooldownUntil.get(m) ?? 0) <= now);
      const verifier = indep[0] ?? same[0];
      if (!verifier) {
        log.emit({ type: "lead.killed", leadId: f.id, stage: "replicator", reason: "no-verifier" });
        return;
      }
      const cross = verifier !== finder && familyOf(verifier) !== finderFamily;
      const window = numberedWindow(lines, f.line, 30);
      const prompt = buildFalsifyPrompt({
        claim: f.claim || f.title,
        quote: f.quote,
        file: f.file,
        line: f.line,
        sourceWindow: window,
        enclosingScope: f.scope || enclosingScopeFor(lines, f.line),
      });
      const ref = parseModelKey(verifier);
      const modelRef: ModelRef = { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) };
      log.emit({ type: "replicator.called", leadId: f.id, model: verifier });
      const t0 = Date.now();
      let raw = "";
      try {
        raw = await withTimeout(deps.generate(modelRef, prompt, REPLICATOR_TIMEOUT_MS), REPLICATOR_TIMEOUT_MS, `verify:${f.id}`);
      } catch (e) {
        const kind = classifyError(e);
        calls += 1;
        log.recordCall(verifier, Date.now() - t0, kind, 0);
        ledger.recordAttempt({ model: verifier, role: "verify", unit: f.id, outcome: kind, ms: Date.now() - t0, rawLen: 0 });
        failModel(verifier, kind);
        return;
      }
      const ms = Date.now() - t0;
      calls += 1;
      const parsed = parseReplicator(raw);
      if (!parsed.output) {
        log.recordCall(verifier, ms, "json-invalid", raw.length);
        ledger.recordAttempt({ model: verifier, role: "verify", unit: f.id, outcome: "json-invalid", ms, rawLen: raw.length });
        return;
      }
      const out = parsed.output;
      log.recordCall(verifier, ms, "ok", raw.length);
      ledger.recordAttempt({ model: verifier, role: "verify", unit: f.id, outcome: "ok", ms, rawLen: raw.length });
      ledger.addVote(f.id, verifier, "verifier", out.verdict, out.reason.slice(0, 500));
      log.emit({ type: "replicator.verdict", leadId: f.id, model: verifier, verdict: out.verdict, reason: out.reason.slice(0, 200) });
      replicatorOfLocal.set(f.id, verifier);
      if (out.verdict === "rejected") {
        ledger.setStatus(f.id, "disputed");
        log.emit({ type: "lead.killed", leadId: f.id, stage: "replicator", reason: out.reason.slice(0, 200) || "rejected" });
        return;
      }
      const hasRecipe = out.verdict === "reproduced" && out.recipe.length > 0 && out.expectedVsActual.trim().length > 0;
      if (cross) {
        if (hasRecipe) {
          ledger.setBasis(f.id, "repro-recipe");
          ledger.setConfidence(f.id, Math.min(0.85, Math.max(0.75, out.confidence)));
        } else {
          ledger.setBasis(f.id, "two-read-cross-model");
          ledger.setConfidence(f.id, Math.min(0.7, Math.max(0.5, out.confidence)));
        }
        ledger.setStatus(f.id, "seconded");
      } else {
        ledger.setBasis(f.id, "two-read-same-model");
        ledger.setConfidence(f.id, Math.min(0.6, out.confidence));
        if (out.verdict === "reproduced") ledger.setStatus(f.id, "seconded");
      }
      ledger.kvSet(
        `repro:${f.id}`,
        JSON.stringify({
          recipe: out.recipe,
          expectedVsActual: out.expectedVsActual,
          unverified: out.unverified,
          nextReads: out.nextReads,
          alternatives: out.alternatives,
          disproofCheck: out.disproofCheck,
          replicator: verifier,
        }),
      );
      log.emit({ type: "lead.promoted", leadId: f.id, model: verifier, verdict: out.verdict });
    }

    // -- assemble ----------------------------------------------------------------
    const survivors = ledger.listFindings().filter((f) => !f.mergedInto);
    const leads: HandoffLead[] = survivors.map((f) => {
      const rawQuote = redactQuote(f.quote);
      const flags = computeFlags({ category: f.category, mechanism: f.mechanism, trigger: f.trigger, quote: f.quote, claim: f.claim || f.title });
      let repro: {
        recipe?: string[];
        expectedVsActual?: string;
        unverified?: string[];
        nextReads?: { loc: string; why: string }[];
        alternatives?: string[];
      } = {};
      try {
        repro = JSON.parse(ledger.kvGet(`repro:${f.id}`) ?? "{}");
      } catch {
        repro = {};
      }
      const nextReads = [...(repro.nextReads ?? []), ...(f.nextReads ?? [])].slice(0, 4);
      const alternatives = [...new Set([...(f.alternatives ?? []), ...(repro.alternatives ?? [])])].slice(0, 4);
      const callers = callersOf.get(f.file) ?? [];
      return {
        id: f.id,
        file: f.file,
        line: f.line,
        ...(f.endLine !== undefined && f.endLine !== null ? { endLine: f.endLine } : {}),
        commit,
        severity: f.severity,
        category: f.category,
        claim: f.claim || f.title,
        mechanism: f.mechanism || "",
        trigger: f.trigger || "",
        quote: rawQuote,
        enclosingScope: f.scope || "",
        alternatives,
        disproof: f.disproof || "",
        reproSteps: repro.recipe ?? [],
        expectedVsActual: repro.expectedVsActual ?? "",
        unverified: repro.unverified ?? [],
        nextReads,
        checkCost: deriveCheckCost(f.basis, nextReads.length),
        blastRadius: callers.length > 0
          ? `${f.severity} ${f.category} in ${f.file}; imported by: ${callers.slice(0, 5).join(", ")}`
          : `${f.severity} ${f.category} in ${f.file}; no known in-repo callers`,
        basis: f.basis,
        confidence: f.confidence,
        provenance: { finder: finderOf.get(f.id) ?? "", replicator: replicatorOfLocal.get(f.id) ?? "", promptVersion },
        untrusted: true as const,
        quoteHash: quoteHash(f.file, f.quote),
        evidenceWindow: "line ±8",
        flags,
        related: [],
      };
    });

    const { kept, merged } = dedupeFindings(leads);
    for (const m of merged) {
      ledger.markMerged(m.dup, m.primary);
      log.emit({ type: "lead.merged", leadId: m.dup, reason: `${m.reason} → ${m.primary}` });
    }
    log.setDeduped(kept.length);
    kept.sort(
      (a, b) =>
        (BASIS_ORDER[a.basis] ?? 9) - (BASIS_ORDER[b.basis] ?? 9) ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.confidence - a.confidence ||
        (a.id < b.id ? -1 : 1),
    );
    const final = kept.slice(0, HANDOFF_CAP);

    // -- manifest ------------------------------------------------------------------
    const cov = ledger.listCoverage().filter((c) => c.promptVersion === promptVersion);
    const coveredHashes = new Set(cov.map((c) => c.chunkHash));
    const modelPerChunk: Record<string, string> = {};
    for (const c of cov) modelPerChunk[c.chunkHash] = c.model;
    const blindSpots: string[] = [];
    const fams = new Set(liveModels().concat(models).map(familyOf));
    if (fams.size <= 1 && models.length > 0) blindSpots.push("single-family pool: confirmations are single-model checks");
    blindSpots.push("files larger than 1MB are excluded from scope");
    const silence: SilenceStat[] = [...silSweeps.entries()].map(([model, s]) => ({
      model,
      sweeps: s.sweeps,
      silent: s.silent,
      silenceRate: s.sweeps > 0 ? s.silent / s.sweeps : null,
      outlier: false,
    }));
    {
      const rates = silence.filter((s) => s.sweeps >= 5).map((s) => s.silenceRate ?? 0).sort((a, b) => a - b);
      const median = rates.length > 0 ? rates[Math.floor(rates.length / 2)]! : 0;
      for (const s of silence) {
        s.outlier = rates.length > 0 && s.sweeps >= 20 && (s.silenceRate ?? 0) >= 0.9 && (s.silenceRate ?? 0) > median + 0.3;
      }
    }
    const manifest: CoverageManifest = {
      commit,
      promptVersion,
      generatedAt: new Date().toISOString(),
      filesSeen,
      chunksTotal,
      chunksCovered: coveredHashes.size,
      skipped,
      modelPerChunk,
      silence,
      blindSpots,
    };
    if (silence.some((s) => s.outlier)) blindSpots.push("a silence outlier model swept 90%+ empty: treat its coverage as weak");

    const status = partial || chunksTotal > coveredHashes.size ? "partial" : "complete";
    const doc = buildDoc({ targetDir, commit, promptVersion, status, leads: final, manifest });
    const handoffPath = join(auditDir, "HANDOFF.md");
    const jsonPath = join(auditDir, "handoff.json");
    const manifestPath = join(auditDir, "manifest.json");
    writeFileSync(handoffPath, renderHandoffMd(doc));
    writeFileSync(jsonPath, renderHandoffJson(doc));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    log.emit({ type: "handoff.written", count: final.length });
    log.setDeduped(kept.length);

    const summary = log.finish({
      status,
      calls,
      coverage: {
        filesSeen,
        chunksTotal,
        chunksCovered: coveredHashes.size,
        skipped: skipped.length,
        blindSpots,
      },
      silence,
    });
    const summaryPath = join(auditDir, "logs", `run-${runId}.summary.json`);
    writeSummaryFile(summaryPath, summary);
    ledger.close();
    return {
      handoffPath,
      jsonPath,
      manifestPath,
      logPath: join(auditDir, "logs", `run-${runId}.jsonl`),
      summaryPath,
      summary,
      stats: { leads: final.length, calls, durationMs: summary.durationMs },
      partial: status !== "complete",
    };
  } catch (e) {
    // Always emit a partial handoff rather than leaving zero artifact.
    try {
      const doc = buildDoc({
        targetDir,
        commit,
        promptVersion,
        status: "partial",
        leads: [],
        manifest: {
          commit,
          promptVersion,
          generatedAt: new Date().toISOString(),
          filesSeen: 0,
          chunksTotal,
          chunksCovered: 0,
          skipped,
          modelPerChunk: {},
          silence: [],
          blindSpots: [`run failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`],
        },
      });
      writeFileSync(join(auditDir, "HANDOFF.md"), renderHandoffMd(doc));
      writeFileSync(join(auditDir, "handoff.json"), renderHandoffJson(doc));
    } catch {
      // Last resort: nothing writable.
    }
    log.emit({ type: "run.failed", reason: String((e as Error)?.message ?? e).slice(0, 500), partialHandoffPath: join(auditDir, "HANDOFF.md") });
    const summary = log.finish({
      status: "failed",
      calls,
      coverage: { filesSeen: 0, chunksTotal, chunksCovered: 0, skipped: skipped.length, blindSpots: [] },
      silence: [],
    });
    const summaryPath = join(auditDir, "logs", `run-${runId}.summary.json`);
    try {
      writeSummaryFile(summaryPath, summary);
    } catch {
      // ignore
    }
    try {
      ledger.close();
    } catch {
      // ignore
    }
    return {
      handoffPath: join(auditDir, "HANDOFF.md"),
      jsonPath: join(auditDir, "handoff.json"),
      manifestPath: join(auditDir, "manifest.json"),
      logPath: join(auditDir, "logs", `run-${runId}.jsonl`),
      summaryPath,
      summary,
      stats: { leads: 0, calls, durationMs: summary.durationMs },
      partial: true,
    };
  }
}

function chunkArr<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
