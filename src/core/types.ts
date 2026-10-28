// Core domain types for the handoff-first audit v1.
// Pure types + tiny helpers. No I/O, no dependencies.

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type FindingStatus = "candidate" | "seconded" | "disputed";

/**
 * Honest epistemics. Never "confirmed".
 * - single-read: one finder, no second read.
 * - two-read-same-model: finder + same-model/same-family falsify pass.
 * - two-read-cross-model: finder + different-family falsify pass.
 * - repro-recipe: cross-model pass that reproduced with a concrete recipe.
 */
export type FindingBasis =
  | "single-read"
  | "two-read-same-model"
  | "two-read-cross-model"
  | "repro-recipe";

export type Lens = "correctness" | "trust-boundary";

export type ReplicatorVerdict = "reproduced" | "plausible-unverified" | "rejected";

export interface NextRead {
  loc: string;
  why: string;
}

export interface FindingInput {
  file: string;
  line: number;
  endLine?: number;
  category: string;
  severity: Severity;
  title: string;
  claim: string;
  mechanism: string;
  trigger: string;
  quote: string;
  scope?: string;
  alternatives?: string[];
  /** Observation that would kill this lead. Required for a lead to survive. */
  disproof: string;
  confidence: number;
  nextReads?: NextRead[];
}

export interface Finding extends FindingInput {
  id: string;
  status: FindingStatus;
  basis: FindingBasis;
  contextHash: string;
  quoteHash: string;
  /** Duplicate of another finding; kept, never deleted. */
  mergedInto?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReplicatorOutput {
  verdict: ReplicatorVerdict;
  reason: string;
  recipe: string[];
  expectedVsActual: string;
  alternatives: string[];
  disproofCheck: string;
  unverified: string[];
  nextReads: NextRead[];
  confidence: number;
}

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export function modelKey(m: ModelRef): string {
  return `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}`;
}

export interface CheckCost {
  filesToOpen: number;
  estMinutes: string;
}

export interface HandoffLead {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  /** Repo HEAD at scan time; "unknown" when not a git repo. */
  commit: string;
  severity: Severity;
  category: string;
  claim: string;
  mechanism: string;
  trigger: string;
  quote: string;
  enclosingScope: string;
  alternatives: string[];
  disproof: string;
  reproSteps: string[];
  expectedVsActual: string;
  unverified: string[];
  nextReads: NextRead[];
  checkCost: CheckCost;
  /** One sentence: who calls this / what breaks. */
  blastRadius: string;
  basis: FindingBasis;
  confidence: number;
  provenance: { finder: string; replicator: string; promptVersion: string };
  untrusted: true;
  quoteHash: string;
  /** e.g. "line ±8" or "enclosing function". */
  evidenceWindow: string;
  /** Machine-readable caution markers, e.g. needs-careful-review. */
  flags: string[];
  related: string[];
}

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface SilenceStat {
  model: string;
  sweeps: number;
  silent: number;
  silenceRate: number | null;
  outlier: boolean;
}

export interface CoverageManifest {
  commit: string;
  promptVersion: string;
  generatedAt: string;
  filesSeen: number;
  chunksTotal: number;
  chunksCovered: number;
  skipped: SkippedFile[];
  modelPerChunk: Record<string, string>;
  silence: SilenceStat[];
  blindSpots: string[];
}

export interface HandoffDoc {
  targetDir: string;
  commit: string;
  generatedAt: string;
  promptVersion: string;
  status: "complete" | "partial";
  leads: HandoffLead[];
  manifest: CoverageManifest;
}

export interface Chunk {
  file: string;
  chunkIndex: number;
  totalChunks: number;
  startLine: number;
  endLine: number;
  /** First lines of the file (imports/header), carried with every chunk. */
  header: string;
  /** Line-numbered body, e.g. "120| const x = 1". */
  text: string;
  /** Hash of the raw (unnumbered) chunk body + file path. */
  hash: string;
  /** Hash of surrounding context used to detect code drift. */
  contextHash: string;
}

export interface Partition {
  id: string;
  files: string[];
  chars: number;
  priority: number;
  boundary: {
    imports: string[];
    exports: string[];
    edges: string[];
  };
}

// ---------------------------------------------------------------------------
// Observability: structured run events + funnel summary.
// ---------------------------------------------------------------------------

export type LeadEventType =
  | "run.started"
  | "partition.created"
  | "finder.called"
  | "finder.reported"
  | "finder.dropped"
  | "lead.created"
  | "replicator.called"
  | "replicator.verdict"
  | "lead.killed"
  | "lead.merged"
  | "lead.promoted"
  | "handoff.written"
  | "run.finished"
  | "run.failed"
  | "feedback.recorded";

export type KillStage = "evidence" | "replicator" | "dedupe" | "lead-budget";

export interface LeadEvent {
  type: LeadEventType;
  at: number;
  runId: string;
  leadId?: string;
  model?: string;
  lens?: Lens;
  partitionId?: string;
  stage?: KillStage;
  reason?: string;
  verdict?: ReplicatorVerdict;
  count?: number;
  ms?: number;
  [k: string]: unknown;
}

export interface FunnelCounts {
  raw: number;
  evidencePassed: number;
  replicatorAttempted: number;
  reproduced: number;
  plausibleUnverified: number;
  rejected: number;
  deduped: number;
  final: number;
  merged: number;
  leadBudgetSpill: number;
}

export interface RunSummary {
  runId: string;
  targetDir: string;
  commit: string;
  scope: "diff" | "full";
  tier: "probe" | "hunt";
  promptVersion: string;
  status: "complete" | "partial" | "failed";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  funnel: FunnelCounts;
  /** rejected / replicator attempts, overall + by model/lens/category/severity. */
  killRate: {
    overall: number | null;
    byModel: Record<string, number | null>;
    byLens: Record<string, number | null>;
  };
  recipeRate: number | null;
  survivalRate: number | null;
  duplicateRate: number | null;
  calls: number;
  tokensProxy: number;
  modelHealth: Record<string, {
    calls: number;
    errors429: number;
    timeouts: number;
    jsonInvalid: number;
    missing: number;
  }>;
  coverage: {
    filesSeen: number;
    chunksTotal: number;
    chunksCovered: number;
    skipped: number;
    blindSpots: string[];
  };
  silence: SilenceStat[];
  feedback?: {
    fixed: number;
    accepted: number;
    rejected: number;
    inconclusive: number;
  };
}

// ---------------------------------------------------------------------------
// Job policy + result.
// ---------------------------------------------------------------------------

export interface JobPolicy {
  scope: "diff" | "full";
  tier: "probe" | "hunt";
  /** Resolved model keys ("provider/id"), in priority order. */
  models: string[];
  lenses?: Lens[];
  perModelMax?: number;
  globalMax?: number;
  leadBudget?: number;
  verifyBudget?: number;
  wallMs?: number;
  promptVersion?: string;
}

export interface JobResult {
  handoffPath: string;
  jsonPath: string;
  manifestPath: string;
  logPath: string;
  summaryPath: string;
  summary: RunSummary;
  stats: {
    leads: number;
    calls: number;
    durationMs: number;
  };
  partial: boolean;
}
