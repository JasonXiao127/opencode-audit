// Run event log + funnel summary. Append-only JSONL; no daemon, no timers.
// The log answers: how often does each stage kill a lead, and is it killing
// the right ones?

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FunnelCounts,
  KillStage,
  LeadEvent,
  Lens,
  ReplicatorVerdict,
  RunSummary,
} from "../core/types.js";

export interface RunMeta {
  runId: string;
  targetDir: string;
  commit: string;
  scope: "diff" | "full";
  tier: "probe" | "hunt";
  promptVersion: string;
}

export class RunLog {
  private funnel: FunnelCounts = {
    raw: 0,
    evidencePassed: 0,
    replicatorAttempted: 0,
    reproduced: 0,
    plausibleUnverified: 0,
    rejected: 0,
    deduped: 0,
    final: 0,
    merged: 0,
    leadBudgetSpill: 0,
  };
  private kills: { stage: KillStage; reason: string }[] = [];
  /** replicator attempts/verdicts keyed by model and lens. */
  private repAttempts: { model: string; lens: string; verdict: ReplicatorVerdict }[] = [];
  private modelHealth = new Map<string, { calls: number; errors429: number; timeouts: number; jsonInvalid: number; missing: number }>();
  private tokensProxy = 0;
  private startedAt = Date.now();

  constructor(
    private readonly logPath: string,
    private readonly meta: RunMeta,
  ) {
    mkdirSync(join(this.logPath, ".."), { recursive: true });
  }

  emit(e: { type: LeadEvent["type"] } & Record<string, unknown>): void {
    const full: LeadEvent = { ...e, at: Date.now(), runId: this.meta.runId };
    try {
      appendFileSync(this.logPath, JSON.stringify(full) + "\n");
    } catch {
      // Logging must never break a run.
    }
    this.tally(full);
  }

  private health(model: string): { calls: number; errors429: number; timeouts: number; jsonInvalid: number; missing: number } {
    let h = this.modelHealth.get(model);
    if (!h) {
      h = { calls: 0, errors429: 0, timeouts: 0, jsonInvalid: 0, missing: 0 };
      this.modelHealth.set(model, h);
    }
    return h;
  }

  private tally(e: LeadEvent): void {
    switch (e.type) {
      case "run.started":
        break;
      case "finder.reported":
        this.funnel.raw += e.count ?? 0;
        break;
      case "finder.dropped":
        this.kills.push({ stage: "evidence", reason: String(e.reason ?? "unknown") });
        break;
      case "lead.created":
        this.funnel.evidencePassed += 1;
        break;
      case "replicator.called":
        this.funnel.replicatorAttempted += 1;
        if (e.model) this.repAttempts.push({ model: e.model, lens: String(e.lens ?? "") as Lens, verdict: "plausible-unverified" });
        break;
      case "replicator.verdict":
        if (e.verdict === "reproduced") this.funnel.reproduced += 1;
        else if (e.verdict === "rejected") this.funnel.rejected += 1;
        else this.funnel.plausibleUnverified += 1;
        if (e.model) {
          const open = [...this.repAttempts].reverse().find((r) => r.model === e.model && r.verdict === "plausible-unverified");
          if (open && e.verdict) open.verdict = e.verdict;
          else this.repAttempts.push({ model: e.model, lens: String(e.lens ?? "") as Lens, verdict: e.verdict ?? "plausible-unverified" });
        }
        break;
      case "lead.killed":
        this.kills.push({ stage: (e.stage as KillStage) ?? "replicator", reason: String(e.reason ?? "unknown") });
        break;
      case "lead.merged":
        this.funnel.merged += 1;
        break;
      case "lead.promoted":
        break;
      case "handoff.written":
        this.funnel.deduped += 0; // deduped is set explicitly via setDeduped
        this.funnel.final += e.count ?? 0;
        break;
      default:
        break;
    }
  }

  setDeduped(uniqueCount: number): void {
    this.funnel.deduped = uniqueCount;
  }

  addLeadBudgetSpill(n: number): void {
    this.funnel.leadBudgetSpill += n;
  }

  recordCall(model: string, ms: number, outcome: "ok" | "e429" | "timeout" | "json-invalid" | "missing" | "error", rawLen = 0): void {
    const h = this.health(model);
    h.calls += 1;
    if (outcome === "e429") h.errors429 += 1;
    else if (outcome === "timeout") h.timeouts += 1;
    else if (outcome === "json-invalid") h.jsonInvalid += 1;
    else if (outcome === "missing") h.missing += 1;
    this.tokensProxy += rawLen;
    void ms;
  }

  private rate(killed: number, total: number): number | null {
    if (total <= 0) return null;
    return Math.round((killed / total) * 1000) / 1000;
  }

  finish(args: {
    status: "complete" | "partial" | "failed";
    calls: number;
    coverage: RunSummary["coverage"];
    silence: { model: string; sweeps: number; silent: number; silenceRate: number | null; outlier: boolean }[];
  }): RunSummary {
    const finishedAt = Date.now();
    const byModel = new Map<string, { k: number; t: number }>();
    const byLens = new Map<string, { k: number; t: number }>();
    for (const r of this.repAttempts) {
      const m = byModel.get(r.model) ?? { k: 0, t: 0 };
      m.t += 1;
      if (r.verdict === "rejected") m.k += 1;
      byModel.set(r.model, m);
      if (r.lens) {
        const l = byLens.get(r.lens) ?? { k: 0, t: 0 };
        l.t += 1;
        if (r.verdict === "rejected") l.k += 1;
        byLens.set(r.lens, l);
      }
    }
    const killRate: RunSummary["killRate"] = { overall: null, byModel: {}, byLens: {} };
    if (this.funnel.replicatorAttempted > 0) {
      killRate.overall = this.rate(this.funnel.rejected, this.funnel.replicatorAttempted);
    }
    for (const [k, v] of byModel) killRate.byModel[k] = this.rate(v.k, v.t);
    for (const [k, v] of byLens) killRate.byLens[k] = this.rate(v.k, v.t);
    const summary: RunSummary = {
      runId: this.meta.runId,
      targetDir: this.meta.targetDir,
      commit: this.meta.commit,
      scope: this.meta.scope,
      tier: this.meta.tier,
      promptVersion: this.meta.promptVersion,
      status: args.status,
      startedAt: this.startedAt,
      finishedAt,
      durationMs: finishedAt - this.startedAt,
      funnel: { ...this.funnel },
      killRate,
      recipeRate: this.rate(this.funnel.reproduced, this.funnel.replicatorAttempted),
      survivalRate: this.rate(this.funnel.final, this.funnel.raw),
      duplicateRate: this.rate(this.funnel.merged, this.funnel.raw),
      calls: args.calls,
      tokensProxy: this.tokensProxy,
      modelHealth: Object.fromEntries(this.modelHealth),
      coverage: args.coverage,
      silence: args.silence,
    };
    return summary;
  }

  killBreakdown(): { stage: KillStage; reason: string; count: number }[] {
    const map = new Map<string, number>();
    for (const k of this.kills) {
      const key = `${k.stage}	${k.reason}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => {
        const [stage, reason] = key.split("	");
        return { stage: stage as KillStage, reason, count };
      })
      .sort((a, b) => b.count - a.count);
  }
}

export function readSummaries(logDir: string, last: number): RunSummary[] {
  if (!existsSync(logDir)) return [];
  const files = readdirSync(logDir).filter((f) => f.endsWith(".summary.json")).sort().reverse();
  const out: RunSummary[] = [];
  for (const f of files.slice(0, Math.max(1, last))) {
    try {
      out.push(JSON.parse(readFileSync(join(logDir, f), "utf8")) as RunSummary);
    } catch {
      // Skip unreadable summaries.
    }
  }
  return out;
}

function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

export function renderStatsText(summaries: RunSummary[]): string {
  if (summaries.length === 0) return "No runs yet.";
  const lines: string[] = [];
  for (const s of summaries) {
    const f = s.funnel;
    lines.push(
      `run ${s.runId} ${s.status} scope=${s.scope} tier=${s.tier} commit=${s.commit.slice(0, 8)} ` +
        `models=${Object.keys(s.modelHealth).join(",") || "—"}`,
      `  funnel raw=${f.raw} evidence-passed=${f.evidencePassed} ` +
        `replicator=${f.replicatorAttempted} (repro=${f.reproduced} plausible=${f.plausibleUnverified} rejected=${f.rejected}) ` +
        `merged=${f.merged} spill=${f.leadBudgetSpill} final=${f.final}`,
      `  kill-rate=${pct(s.killRate.overall)} recipe-rate=${pct(s.recipeRate)} survival=${pct(s.survivalRate)} ` +
        `dup-rate=${pct(s.duplicateRate)} calls=${s.calls} wall=${Math.round(s.durationMs / 1000)}s`,
      `  coverage files=${s.coverage.filesSeen} chunks=${s.coverage.chunksCovered}/${s.coverage.chunksTotal} skipped=${s.coverage.skipped}`,
    );
    const perModel = Object.entries(s.killRate.byModel);
    if (perModel.length > 0) {
      lines.push(`  kill-rate by model: ${perModel.map(([m, r]) => `${m}=${pct(r)}`).join(" ")}`);
    }
    if (s.coverage.blindSpots.length > 0) lines.push(`  blind spots: ${s.coverage.blindSpots.join("; ")}`);
  }
  return lines.join("\n");
}

export function writeSummaryFile(path: string, summary: RunSummary): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2));
}
