// Basis labels, ranking, section names, and check-cost estimates.
// Pure logic, no I/O.

import type { CheckCost, FindingBasis, Severity } from "./types.js";

/** Rank order: lower wins. Never add a fifth rank; same-family multi-read maps to index 2. */
export const BASIS_ORDER: Record<FindingBasis, number> = {
  "repro-recipe": 0,
  "two-read-cross-model": 1,
  "two-read-same-model": 2,
  "single-read": 3,
};

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const BASIS_COUNT = 4;

/** Minimal shape rankScore/sortFindings need; Finding and HandoffLead both satisfy it. */
export interface Rankable {
  basis: FindingBasis;
  severity: Severity;
  confidence: number;
}

function clampConfidence(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return Math.min(1, Math.max(0, c));
}

/**
 * Higher is better. Basis dominates (steps of 100 exceed the max
 * severity + confidence contribution of 41), severity is secondary
 * (steps of 10), confidence only breaks ties (at most 1).
 */
export function rankScore(f: Rankable): number {
  const basisRank = BASIS_ORDER[f.basis] ?? (BASIS_COUNT - 1);
  const sev = SEVERITY_WEIGHT[f.severity] ?? 0;
  return (BASIS_COUNT - 1 - basisRank) * 100 + sev * 10 + clampConfidence(f.confidence);
}

/** Stable descending sort by rankScore. Returns a new array. */
export function sortFindings<T extends Rankable>(findings: readonly T[]): T[] {
  return [...findings]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rankScore(b.f) - rankScore(a.f) || a.i - b.i)
    .map(({ f }) => f);
}

/**
 * Handoff section for a finding. Disputed status always wins its own
 * section. Labels use honest basis language — never "confirmed".
 */
export function sectionFor(input: FindingBasis | { basis: FindingBasis; status?: string }): string {
  const basis = typeof input === "string" ? input : input.basis;
  if (typeof input !== "string" && input.status === "disputed") return "Disputed";
  switch (basis) {
    case "repro-recipe":
      return "Leads with recipes";
    case "two-read-cross-model":
      return "Two reads, cross-model";
    case "two-read-same-model":
      return "Two reads, same model — verify first";
    case "single-read":
      return "Single read — kill or promote";
    default:
      return "Single read — kill or promote";
  }
}

const BASE_MINUTES: Record<FindingBasis, number> = {
  "repro-recipe": 5,
  "two-read-cross-model": 5,
  "two-read-same-model": 10,
  "single-read": 10,
};

/**
 * Downstream investigation cost: one file for the lead itself plus one
 * per suggested next read; less-verified bases budget more minutes.
 */
export function deriveCheckCost(basis: FindingBasis, nextReadsCount: number): CheckCost {
  const n = Number.isFinite(nextReadsCount) ? Math.max(0, Math.floor(nextReadsCount)) : 0;
  const lo = (BASE_MINUTES[basis] ?? 10) + n * 5;
  return { filesToOpen: 1 + n, estMinutes: `${lo}–${lo + 5} min` };
}
