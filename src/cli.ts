// Minimal CLI: `audit run`, `audit stats`, `audit feedback`.
// The plugin shell and multi-repo fleet arrive post-A/B; this CLI drives
// single-repo one-shot jobs and reads back run statistics.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runJob } from "./audit/jobRunner.js";
import { readSummaries, renderStatsText } from "./audit/runlog.js";
import type { JobPolicy, ModelRef, RunSummary } from "./core/types.js";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return dflt;
  return process.argv[i + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): string {
  return [
    "audit run <repo> [--scope diff|full] [--tier probe|hunt] [--models m1,m2]",
    "  [--max-calls N] [--lead-budget N] [--verify-budget N] [--wall-minutes N]",
    "  [--concurrency N] [--per-model N]",
    "audit stats [--dir <repo|.audit>] [--last N]",
    "audit feedback <lead-id> <fixed|accepted|rejected|inconclusive> [notes] [--dir <repo|.audit>]",
  ].join("\n");
}

function auditDirOf(dir: string): string {
  const abs = resolve(dir);
  if (abs.endsWith(".audit") && existsSync(abs)) return abs;
  return join(abs, ".audit");
}

/** Best-effort OpenRouter adapter. Requires OPENROUTER_API_KEY. */
async function openRouterGenerate(model: ModelRef, prompt: string, timeoutMs: number): Promise<string> {
  const key = process.env["OPENROUTER_API_KEY"];
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const id = `${model.providerID}/${model.id}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://github.com/JasonXiao127/opencode-audit",
        "X-Title": "opencode-audit",
      },
      signal: ctrl.signal,
      body: JSON.stringify({ model: id, messages: [{ role: "user", content: prompt }] }),
    });
    if (res.status === 429) throw new Error(`429 rate limited for ${id}`);
    if (res.status === 404) throw new Error(`model not found: ${id}`);
    if (!res.ok) throw new Error(`provider error ${res.status} for ${id}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error(`empty completion for ${id}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function cmdRun(repo: string): Promise<number> {
  const scope = arg("--scope", "diff") === "full" ? "full" : "diff";
  const tier = arg("--tier", "hunt") === "probe" ? "probe" : "hunt";
  const models = (arg("--models", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (models.length === 0) {
    console.error("run needs --models m1,m2 (provider/id keys)");
    return 2;
  }
  const num = (name: string, dflt: number): number => {
    const v = Number(arg(name, String(dflt)));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
  };
  const policy: JobPolicy = {
    scope,
    tier,
    models,
    perModelMax: num("--per-model", 3),
    globalMax: num("--concurrency", 12),
    leadBudget: num("--lead-budget", 200),
    verifyBudget: num("--verify-budget", 50),
    wallMs: num("--wall-minutes", 45) * 60_000,
  };
  void num("--max-calls", 0);
  console.log(`audit run ${resolve(repo)} scope=${scope} tier=${tier} models=${models.join(",")}`);
  const result = await runJob({ generate: openRouterGenerate }, repo, policy);
  console.log(`handoff: ${result.handoffPath}`);
  console.log(`leads=${result.stats.leads} calls=${result.stats.calls} wall=${Math.round(result.stats.durationMs / 1000)}s partial=${result.partial}`);
  return result.partial ? 1 : 0;
}

function cmdStats(): number {
  const dir = auditDirOf(arg("--dir", ".") ?? ".");
  const last = Number(arg("--last", "10") ?? "10");
  const summaries = readSummaries(join(dir, "logs"), Number.isFinite(last) ? last : 10);
  console.log(renderStatsText(summaries));
  return 0;
}

function latestSummaryPath(logDir: string): string | null {
  const summaries = readSummaries(logDir, 1);
  if (summaries.length === 0) return null;
  return join(logDir, `run-${summaries[0].runId}.summary.json`);
}

function cmdFeedback(leadId: string, outcome: string, notes: string): number {
  if (!["fixed", "accepted", "rejected", "inconclusive"].includes(outcome)) {
    console.error("outcome must be fixed|accepted|rejected|inconclusive");
    return 2;
  }
  const dir = auditDirOf(arg("--dir", ".") ?? ".");
  const logDir = join(dir, "logs");
  const summaryPath = latestSummaryPath(logDir);
  if (!summaryPath || !existsSync(summaryPath)) {
    console.error("no runs yet in " + logDir);
    return 2;
  }
  const runId = summaryPath.split("run-")[1]!.replace(".summary.json", "");
  appendFileSync(join(logDir, `run-${runId}.jsonl`), JSON.stringify({ type: "feedback.recorded", at: Date.now(), runId, leadId, outcome, notes }) + "\n");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as RunSummary;
  const fb = summary.feedback ?? { fixed: 0, accepted: 0, rejected: 0, inconclusive: 0 };
  if (outcome === "fixed") fb.fixed += 1;
  else if (outcome === "accepted") fb.accepted += 1;
  else if (outcome === "rejected") fb.rejected += 1;
  else fb.inconclusive += 1;
  summary.feedback = fb;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  const total = fb.fixed + fb.accepted + fb.rejected + fb.inconclusive;
  const accepted = fb.fixed + fb.accepted;
  console.log(`feedback recorded for ${leadId}: ${outcome} (acceptance ${accepted}/${total})`);
  return 0;
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "run" && rest[0]) return cmdRun(rest[0]);
  if (cmd === "stats") return cmdStats();
  if (cmd === "feedback" && rest[0] && rest[1]) return cmdFeedback(rest[0], rest[1], rest.slice(2).join(" "));
  console.error(usage());
  return 2;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? "");
if (isMain || has("--audit-main")) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(String((e as Error)?.message ?? e));
      process.exit(1);
    },
  );
}
