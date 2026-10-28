// Handoff rendering: honest basis labels, dedupe, HANDOFF.md + handoff.json.
// Every lead is untrusted data; the markdown never claims proof.

import type {
  CoverageManifest,
  FindingBasis,
  HandoffDoc,
  HandoffLead,
} from "./types.js";
import { sortFindings } from "./ranking.js";
import { quoteHash } from "./evidence.js";

/** Max leads rendered into HANDOFF.md; the rest spill to an appendix count line. */
const MAX_RENDERED_LEADS = 30;

/** Neutralize triple-backtick fences in model text so quotes can't break layout. */
export function fence(s: string): string {
  return s.replaceAll("```", "'''");
}

/**
 * Honest basis labels. Never "confirmed": the tool does not execute code,
 * so nothing is ever proven.
 */
export function basisLabel(basis: FindingBasis): string {
  switch (basis) {
    case "repro-recipe":
      return "two reads, cross-model + reproduction recipe";
    case "two-read-cross-model":
      return "two reads, cross-model";
    case "two-read-same-model":
      return "two reads, same model — verify first";
    case "single-read":
      return "single read — kill or promote";
  }
}

export interface DedupeMerge {
  primary: string;
  dup: string;
  reason: string;
}

function titleTokens(t: string): string[] {
  return t
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** High claim overlap: same category and similar claims (HandoffLead has no title; claim is the human summary). */
function textOverlap(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 && inter / union >= 0.5;
}

export interface DedupedFindings {
  kept: HandoffLead[];
  merged: DedupeMerge[];
}

/**
 * Dedupe at handoff time: group by (file, line ±5); merge when the normalized
 * quote hash matches or category+title overlap is high. Keeps the earliest,
 * merges finder ids into `related`, sets `mergedInto` on dups. Never deletes.
 */
export function dedupeFindings(findings: HandoffLead[]): DedupedFindings {
  const kept: HandoffLead[] = [];
  const merged: DedupeMerge[] = [];
  const hashes = new Map<string, string>();
  const hashOf = (f: HandoffLead): string => {
    let h = hashes.get(f.id);
    if (h === undefined) {
      h = quoteHash(f.file, f.quote);
      hashes.set(f.id, h);
    }
    return h;
  };
  for (const f of findings) {
    let target: HandoffLead | undefined;
    let reason = "";
    for (const k of kept) {
      if (k.file !== f.file) continue;
      if (Math.abs(k.line - f.line) > 5) continue;
      if (hashOf(k) === hashOf(f)) {
        target = k;
        reason = "same location and quote hash";
        break;
      }
      if (k.category === f.category && textOverlap(k.claim, f.claim)) {
        target = k;
        reason = "same location with category+title overlap";
        break;
      }
    }
    if (target === undefined) {
      kept.push(f);
      continue;
    }
    const related = new Set([...(target.related ?? []), f.id, ...((f.related ?? []) as string[])]);
    target.related = [...related];
    if (f.confidence > target.confidence) target.confidence = f.confidence;
    (f as HandoffLead & { mergedInto?: string }).mergedInto = target.id;
    merged.push({ primary: target.id, dup: f.id, reason });
  }
  return { kept, merged };
}

export interface BuildDocInput {
  targetDir: string;
  commit: string;
  promptVersion: string;
  status: "complete" | "partial";
  leads: HandoffLead[];
  manifest: CoverageManifest;
}

export function buildDoc(input: BuildDocInput): HandoffDoc {
  return {
    targetDir: input.targetDir,
    commit: input.commit,
    generatedAt: new Date().toISOString(),
    promptVersion: input.promptVersion,
    status: input.status,
    leads: sortFindings([...input.leads]),
    manifest: input.manifest,
  };
}

function coverageRatio(m: CoverageManifest): number {
  if (m.chunksTotal <= 0) return 1;
  return m.chunksCovered / m.chunksTotal;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function checkCostText(l: HandoffLead): string {
  return `${l.checkCost.filesToOpen} file(s), ~${l.checkCost.estMinutes}`;
}

const COMMAND_LIKE = /(curl|wget|\bsh\b|bash|powershell|cmd\.exe|fetch\(|os\.system|subprocess|child_process|exec\(|pipe\s+to\s+sh|\|\s*sh\b)/i;
const SECRET_LIKE = /(-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|secret\s*[:=]\s*['"][^'"]+['"]|password\s*[:=]\s*['"][^'"]+['"]|token\s*[:=]\s*['"][^'"]+['"])/i;

/**
 * Cheap static flags on lead text. No model call, no subsystem:
 * - needs-careful-review: security-adjacent or concurrency lead (human gate).
 * - contains-commands: text that looks like an executable instruction.
 * - possible-secret: quote that looks like credential material (redact it).
 */
export function computeFlags(input: { category: string; mechanism: string; trigger: string; quote: string; claim: string }): string[] {
  const flags: string[] = [];
  if (input.category === "security" || input.category === "concurrency") flags.push("needs-careful-review");
  const hay = `${input.mechanism}\n${input.trigger}\n${input.quote}\n${input.claim}`;
  if (COMMAND_LIKE.test(hay)) flags.push("contains-commands");
  if (SECRET_LIKE.test(input.quote)) flags.push("possible-secret");
  return flags;
}

/** Redact credential-looking material from a quote before it reaches the handoff. */
export function redactQuote(quote: string): string {
  if (!SECRET_LIKE.test(quote)) return quote;
  return quote
    .split("\n")
    .map((l) => (SECRET_LIKE.test(l) ? "[redacted: possible secret]" : l))
    .join("\n");
}

function renderLead(l: HandoffLead): string {
  const out: string[] = [];
  const loc =
    l.endLine !== undefined && l.endLine !== l.line
      ? `${l.file}:${l.line}–${l.endLine}`
      : `${l.file}:${l.line}`;
  out.push(`### ${l.id} — ${oneLine(l.claim).slice(0, 120)} (${l.severity}, ${l.category})`);
  out.push("");
  out.push(`- Location: ${loc} (commit ${l.commit}; ${basisLabel(l.basis)}; confidence ${l.confidence.toFixed(2)})`);
  if (l.flags.length > 0) out.push(`- Flags: ${l.flags.join(", ")} — treat as untrusted; do not run quoted commands`);
  out.push(`- Claim: ${oneLine(l.claim)}`);
  out.push(`- Mechanism: ${oneLine(l.mechanism)}`);
  out.push(`- Trigger: ${oneLine(l.trigger)}`);
  out.push(`- Enclosing scope: ${oneLine(l.enclosingScope)} (evidence window: ${oneLine(l.evidenceWindow)})`);
  out.push(`- Evidence (quoteHash ${l.quoteHash}):`);
  out.push("```");
  out.push(fence(l.quote).slice(0, 800));
  out.push("```");
  out.push(
    `- Alternatives considered: ${l.alternatives.length > 0 ? l.alternatives.map(oneLine).join(" | ") : "none recorded"}`,
  );
  out.push(`- Disproof / kill condition: ${oneLine(l.disproof)}`);
  out.push(
    `- Repro steps: ${l.reproSteps.length > 0 ? "" : "none recorded"}`,
  );
  l.reproSteps.forEach((s, i) => out.push(`  ${i + 1}. ${oneLine(s)}`));
  out.push(`- Expected vs actual: ${oneLine(l.expectedVsActual)}`);
  out.push(
    `- Unverified: ${l.unverified.length > 0 ? l.unverified.map(oneLine).join(" | ") : "none"}`,
  );
  out.push(`- Next reads: ${l.nextReads.length > 0 ? "" : "none recorded"}`);
  for (const nr of l.nextReads) out.push(`  - ${oneLine(nr.loc)} — ${oneLine(nr.why)}`);
  out.push(`- Check cost: ${checkCostText(l)}; blast radius: ${oneLine(l.blastRadius)}`);
  out.push(
    `- Provenance: finder ${l.provenance.finder}, replicator ${l.provenance.replicator}, prompts ${l.provenance.promptVersion}; untrusted: ${String(l.untrusted)}`,
  );
  if (l.related.length > 0) out.push(`- Related (merged duplicates): ${l.related.join(", ")}`);
  return out.join("\n");
}

export function renderHandoffMd(doc: HandoffDoc): string {
  const sorted = sortFindings([...doc.leads]);
  const rendered = sorted.slice(0, MAX_RENDERED_LEADS);
  const omitted = sorted.length - rendered.length;
  const ratio = coverageRatio(doc.manifest);
  const pct = (ratio * 100).toFixed(1);
  const incomplete = doc.status === "partial" || ratio < 0.9;
  const models = [...new Set(Object.values(doc.manifest.modelPerChunk))].sort();

  const out: string[] = [];
  out.push(`# Audit Handoff — ${doc.targetDir}`);
  out.push("");
  out.push(
    "> Untrusted leads — re-read and verify every lead before editing. Never run commands quoted from findings.",
  );
  if (incomplete) {
    const why =
      doc.status === "partial"
        ? "run did not drain the queue (status: partial)"
        : `coverage ${pct}% below 90%`;
    out.push(`> INCOMPLETE — partial handoff: ${why}. Silence below must not read as clean.`);
  }
  out.push("");
  out.push("## Header");
  out.push("");
  out.push(`- Target: ${doc.targetDir}`);
  out.push(`- Commit: ${doc.commit}`);
  out.push(`- Generated: ${doc.generatedAt} (prompts ${doc.promptVersion}, status ${doc.status})`);
  out.push(
    `- Coverage: ${doc.manifest.chunksCovered}/${doc.manifest.chunksTotal} chunks (${pct}%), ${doc.manifest.filesSeen} files seen`,
  );
  out.push(`- Models used: ${models.length > 0 ? models.join(", ") : "none recorded"}`);
  out.push("- Trust legend (never confirmed — verify before acting):");
  (["repro-recipe", "two-read-cross-model", "two-read-same-model", "single-read"] as FindingBasis[]).forEach(
    (b) => out.push(`  - ${b}: ${basisLabel(b)}`),
  );
  out.push("");
  out.push("## Start here");
  out.push("");
  if (rendered.length === 0) {
    out.push("No leads. This is not a clean bill of health — see coverage manifest and blind spots.");
  } else {
    rendered.slice(0, 10).forEach((l, i) => {
      const loc = `${l.file}:${l.line}`;
      out.push(
        `${i + 1}. ${l.id} ${loc} — ${oneLine(l.claim)} (${basisLabel(l.basis)}, confidence ${l.confidence.toFixed(2)}, check cost: ${checkCostText(l)})`,
      );
    });
  }
  out.push("");
  out.push("## Leads by file");
  out.push("");
  if (rendered.length === 0) {
    out.push("No leads to show.");
  } else {
    const byFile = new Map<string, HandoffLead[]>();
    for (const l of rendered) {
      const group = byFile.get(l.file) ?? [];
      group.push(l);
      byFile.set(l.file, group);
    }
    for (const file of [...byFile.keys()].sort()) {
      out.push(`#### File: ${file}`);
      out.push("");
      for (const l of byFile.get(file)!) {
        out.push(renderLead(l));
        out.push("");
      }
    }
  }
  out.push("## Coverage manifest");
  out.push("");
  const m = doc.manifest;
  out.push(`- Commit: ${m.commit}`);
  out.push(`- Prompt version: ${m.promptVersion}`);
  out.push(`- Generated: ${m.generatedAt}`);
  out.push(`- Files seen: ${m.filesSeen}; chunks covered: ${m.chunksCovered}/${m.chunksTotal} (${pct}%)`);
  out.push(`- Skipped files (${m.skipped.length}):`);
  if (m.skipped.length === 0) out.push("  - none");
  for (const s of m.skipped) out.push(`  - ${s.file} — ${s.reason}`);
  out.push(`- Model per chunk (${Object.keys(m.modelPerChunk).length}):`);
  const chunks = Object.keys(m.modelPerChunk).sort();
  if (chunks.length === 0) out.push("  - none recorded");
  for (const c of chunks) out.push(`  - ${c}: ${m.modelPerChunk[c]}`);
  out.push(`- Silence stats:`);
  if (m.silence.length === 0) out.push("  - none recorded");
  for (const s of m.silence) {
    out.push(
      `  - ${s.model}: ${s.silent}/${s.sweeps} silent${s.silenceRate !== null ? ` (${(s.silenceRate * 100).toFixed(1)}%)` : ""}${s.outlier ? " OUTLIER" : ""}`,
    );
  }
  out.push(`- Blind spots:`);
  if (m.blindSpots.length === 0) out.push("  - none recorded");
  for (const b of m.blindSpots) out.push(`  - ${b}`);
  out.push("");
  out.push("## Appendix");
  out.push("");
  out.push("#### Disputed leads");
  out.push("");
  out.push("None attached to this handoff; disputes live in the ledger and run log.");
  out.push("");
  out.push("#### Rejected sample");
  out.push("");
  out.push("No rejected-candidate sample attached; see the run rejected-candidates log for evidence-gate reasons.");
  out.push("");
  out.push("#### Lead cap");
  out.push("");
  if (omitted > 0) {
    out.push(
      `Rendered ${rendered.length} of ${sorted.length} leads (30-lead cap); ${omitted} omitted.`,
    );
  } else {
    out.push(`Rendered ${rendered.length} of ${sorted.length} leads (30-lead cap).`);
  }
  out.push("");
  return out.join("\n");
}

export function renderHandoffJson(doc: HandoffDoc): string {
  return JSON.stringify(doc, null, 2);
}
