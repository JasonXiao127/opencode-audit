// Durable SQLite ledger for findings, votes, coverage, attempts, rejected, runs, kv.
// Backed by the built-in node:sqlite (DatabaseSync) in WAL mode.
// The ledger is a durable record, not a coordination mechanism: inserts and
// merges only, never deletes.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  Finding,
  FindingBasis,
  FindingInput,
  FindingStatus,
} from "./types.js";

export interface AttemptInput {
  model: string;
  role: string;
  unit: string;
  outcome: string;
  ms: number;
  rawLen: number;
}

export interface RejectedInput {
  file: string;
  line: number;
  title: string;
  reason: string;
  model: string;
}

export interface RejectedRow extends RejectedInput {
  createdAt: number;
}

/**
 * Deterministic finding id: AUD-XXXXXXXX (upper-case hex) derived from
 * file + category + quote, so the same candidate re-reported later maps to
 * the same row and merges instead of duplicating.
 */
export function findingId(file: string, quote: string, category: string): string {
  const h = createHash("sha256");
  h.update(file, "utf8");
  h.update("\0", "utf8");
  h.update(category, "utf8");
  h.update("\0", "utf8");
  h.update(quote, "utf8");
  return `AUD-${h.digest("hex").slice(0, 8).toUpperCase()}`;
}

function quoteHashLocal(file: string, quote: string): string {
  return createHash("sha256").update(`${file}\0${quote}`, "utf8").digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  trigger TEXT NOT NULL,
  quote TEXT NOT NULL,
  scope TEXT,
  alternatives TEXT NOT NULL,
  disproof TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  basis TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  merged_into TEXT,
  provenance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coverage (
  chunk_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  file TEXT NOT NULL,
  findings_kept INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_hash, model, prompt_version)
);
CREATE TABLE IF NOT EXISTS model_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  unit TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ms INTEGER NOT NULL,
  raw_len INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rejected (
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_dir TEXT NOT NULL,
  "commit" TEXT NOT NULL,
  scope TEXT NOT NULL,
  tier TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

interface FindingRow {
  id: string;
  file: string;
  line: number;
  end_line: number | null;
  category: string;
  severity: string;
  title: string;
  claim: string;
  mechanism: string;
  trigger: string;
  quote: string;
  scope: string | null;
  alternatives: string;
  disproof: string;
  confidence: number;
  status: string;
  basis: string;
  context_hash: string;
  quote_hash: string;
  merged_into: string | null;
  provenance: string;
  created_at: number;
  updated_at: number;
}

function rowToFinding(row: FindingRow): Finding {
  let alternatives: string[];
  try {
    const parsed: unknown = JSON.parse(row.alternatives);
    alternatives = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    alternatives = [];
  }
  return {
    id: row.id,
    file: row.file,
    line: row.line,
    endLine: row.end_line ?? undefined,
    category: row.category,
    severity: row.severity as Finding["severity"],
    title: row.title,
    claim: row.claim,
    mechanism: row.mechanism,
    trigger: row.trigger,
    quote: row.quote,
    scope: row.scope ?? undefined,
    alternatives,
    disproof: row.disproof,
    confidence: row.confidence,
    status: row.status as FindingStatus,
    basis: row.basis as FindingBasis,
    contextHash: row.context_hash,
    quoteHash: row.quote_hash,
    mergedInto: row.merged_into ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Ledger {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Deterministic id for a (file, quote, category) triple. */
  findingId(file: string, quote: string, category: string): string {
    return findingId(file, quote, category);
  }

  /**
   * Insert a new candidate, or merge the finder into the existing row's
   * provenance when the id already exists. Existing field values are kept;
   * rows are never deleted or overwritten.
   */
  upsertCandidate(input: FindingInput, contextHash: string, finderModel: string): string {
    const id = findingId(input.file, input.quote, input.category);
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT provenance FROM findings WHERE id = ?")
      .get(id) as unknown as { provenance: string } | undefined;
    if (existing) {
      let prov: { finders?: string[] } = {};
      try {
        prov = JSON.parse(existing.provenance) as { finders?: string[] };
      } catch {
        prov = {};
      }
      const finders = Array.isArray(prov.finders) ? prov.finders : [];
      if (!finders.includes(finderModel)) finders.push(finderModel);
      this.db
        .prepare("UPDATE findings SET provenance = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...prov, finders }), now, id);
      return id;
    }
    this.db
      .prepare(
        `INSERT INTO findings
          (id, file, line, end_line, category, severity, title, claim, mechanism,
           trigger, quote, scope, alternatives, disproof, confidence, status, basis,
           context_hash, quote_hash, merged_into, provenance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.file,
        input.line,
        input.endLine ?? null,
        input.category,
        input.severity,
        input.title,
        input.claim,
        input.mechanism,
        input.trigger,
        input.quote,
        input.scope ?? null,
        JSON.stringify(input.alternatives ?? []),
        input.disproof,
        input.confidence,
        "candidate",
        "single-read",
        contextHash,
        quoteHashLocal(input.file, input.quote),
        JSON.stringify({ finders: [finderModel] }),
        now,
        now,
      );
    return id;
  }

  getFinding(id: string): Finding | undefined {
    const row = this.db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as unknown as
      | FindingRow
      | undefined;
    if (!row) return undefined;
    return rowToFinding(row);
  }

  setStatus(id: string, status: FindingStatus): void {
    this.db
      .prepare("UPDATE findings SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), id);
  }

  setBasis(id: string, basis: FindingBasis): void {
    this.db
      .prepare("UPDATE findings SET basis = ?, updated_at = ? WHERE id = ?")
      .run(basis, Date.now(), id);
  }

  setConfidence(id: string, confidence: number): void {
    this.db
      .prepare("UPDATE findings SET confidence = ?, updated_at = ? WHERE id = ?")
      .run(confidence, Date.now(), id);
  }

  /** Mark a duplicate; the row is kept, never deleted. */
  markMerged(dupId: string, primaryId: string): void {
    this.db
      .prepare("UPDATE findings SET merged_into = ?, updated_at = ? WHERE id = ?")
      .run(primaryId, Date.now(), dupId);
  }

  addVote(
    findingId_: string,
    model: string,
    role: "finder" | "verifier",
    verdict: string,
    reason: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO votes (finding_id, model, role, verdict, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(findingId_, model, role, verdict, reason, Date.now());
  }

  recordCoverage(
    chunkHash: string,
    model: string,
    promptVersion: string,
    file: string,
    kept: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO coverage
           (chunk_hash, model, prompt_version, file, findings_kept, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(chunkHash, model, promptVersion, file, kept, Date.now());
  }

  hasCoverage(chunkHash: string, promptVersion: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM coverage WHERE chunk_hash = ? AND prompt_version = ? LIMIT 1")
      .get(chunkHash, promptVersion) as unknown as { ok: number } | undefined;
    return row !== undefined;
  }

  recordAttempt(a: AttemptInput): void {
    this.db
      .prepare(
        "INSERT INTO model_attempts (model, role, unit, outcome, ms, raw_len, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(a.model, a.role, a.unit, a.outcome, a.ms, a.rawLen, Date.now());
  }

  recordRejected(r: RejectedInput): void {
    this.db
      .prepare(
        "INSERT INTO rejected (file, line, title, reason, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(r.file, r.line, r.title, r.reason, r.model, Date.now());
  }

  listFindings(status?: FindingStatus): Finding[] {
    const rows =
      status === undefined
        ? (this.db.prepare("SELECT * FROM findings ORDER BY file, line, id").all() as unknown as FindingRow[])
        : (this.db
            .prepare("SELECT * FROM findings WHERE status = ? ORDER BY file, line, id")
            .all(status) as unknown as FindingRow[]);
    return rows.map(rowToFinding);
  }

  listRejected(limit: number): RejectedRow[] {
    const rows = this.db
      .prepare("SELECT * FROM rejected ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(Math.max(0, Math.floor(limit))) as unknown as Array<{
      file: string;
      line: number;
      title: string;
      reason: string;
      model: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      file: r.file,
      line: r.line,
      title: r.title,
      reason: r.reason,
      model: r.model,
      createdAt: r.created_at,
    }));
  }

  listCoverage(): {
    chunkHash: string;
    model: string;
    promptVersion: string;
    file: string;
    findingsKept: number;
  }[] {
    return this.db
      .prepare(
        "SELECT chunk_hash AS chunkHash, model, prompt_version AS promptVersion, file, findings_kept AS findingsKept FROM coverage",
      )
      .all() as {
      chunkHash: string;
      model: string;
      promptVersion: string;
      file: string;
      findingsKept: number;
    }[];
  }

  filesWithCoverage(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT file AS file FROM coverage ORDER BY file")
      .all() as unknown as Array<{ file: string }>;
    return rows.map((r) => r.file);
  }

  kvGet(k: string): string | undefined {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as unknown as
      | { v: string }
      | undefined;
    return row?.v;
  }

  kvSet(k: string, v: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(k, v);
  }

  close(): void {
    this.db.close();
  }
}
